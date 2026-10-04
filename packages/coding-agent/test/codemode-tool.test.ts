import type { AgentTool, AgentToolCallOutcome } from "@candy/agent-core";
import type { CodemodeStoreWrites } from "@candy/codemode";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { CODEMODE_STORE_ENTRY_TYPE, createCodemodeToolDefinition } from "../src/core/codemode-tool.ts";
import type { SessionEntry } from "../src/core/session-records.ts";

describe("codemode tool", () => {
	it("executes without discovery functions, metadata globals, or namespace descriptions", async () => {
		const tool: AgentTool = {
			name: "lookup",
			label: "Lookup",
			description: "Look up a synthetic item",
			parameters: Type.Object({ secretItemId: Type.String() }),
			namespace: { name: "fixture" },
			execute: async () => ({ content: [], details: undefined }),
		};
		const definition = createCodemodeToolDefinition({
			getTools: () => [tool],
			getBranch: () => [],
			appendEntry: () => {},
			executeTool: async () => {
				throw Error("unexpected tool call");
			},
		});
		expect(definition.description).toContain("search_mcp_tools");
		expect(definition.description).toContain("Use bash for standalone calculations");
		expect(definition.description).toContain("Each execution has fresh variables");
		expect(definition.description).not.toContain("secretItemId");
		expect(definition.description).not.toContain("Namespaces:");
		const result = await definition.execute(
			"globals",
			{ code: "text([typeof searchTools, typeof describeTool, typeof describeNamespace, typeof ALL_TOOLS]);" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: '["undefined","undefined","undefined","undefined"]' }]);
	});

	it("calls an authorized tool, then commits successful store writes", async () => {
		const tools: AgentTool[] = [
			{
				name: "lookup",
				label: "Lookup",
				description: "Look up a synthetic item",
				parameters: Type.Object({ id: Type.String() }),
				namespace: { name: "fixture", description: "Synthetic data" },
				execute: async () => ({ content: [], details: undefined }),
			},
		];
		const branch: SessionEntry[] = [];
		const writes: CodemodeStoreWrites[] = [];
		const definition = createCodemodeToolDefinition({
			getTools: () => tools,
			getBranch: () => branch,
			appendEntry: (kind, data) => {
				expect(kind).toBe(CODEMODE_STORE_ENTRY_TYPE);
				writes.push(data);
				branch.push({
					type: "custom",
					id: String(branch.length + 1),
					parentId: branch.at(-1)?.id ?? null,
					timestamp: new Date().toISOString(),
					customType: kind,
					data,
				});
			},
			executeTool: async (name, args): Promise<AgentToolCallOutcome> => ({
				toolCall: { type: "toolCall", id: "nested", name, arguments: args as never },
				result: { content: [{ type: "text", text: "item-42" }], details: undefined },
				isError: false,
			}),
		});
		const result = await definition.execute(
			"parent",
			{
				code: 'text(await tools.lookup({id:"42"})); store("last", 42);',
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.isError).toBe(false);
		expect(result.content.filter((block) => block.type === "text").map((block) => block.text)).toEqual(["item-42"]);
		expect(result.details.calls[0].status).toBe("ok");
		expect(writes).toEqual([{ set: { last: 42 }, delete: [] }]);
		const resumed = await definition.execute(
			"next",
			{ code: 'text(load("last"));' },
			undefined,
			undefined,
			undefined as never,
		);
		expect(resumed.content).toEqual([{ type: "text", text: "42" }]);
	});

	it("does not commit writes from a failed script", async () => {
		const writes: CodemodeStoreWrites[] = [];
		const definition = createCodemodeToolDefinition({
			getTools: () => [],
			getBranch: () => [],
			appendEntry: (_kind, data) => {
				writes.push(data);
			},
			executeTool: async () => {
				throw new Error("unexpected tool call");
			},
		});
		const result = await definition.execute(
			"parent",
			{ code: 'store("last", 42); throw new Error("failed");' },
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.isError).toBe(true);
		expect(writes).toEqual([]);
	});

	it("aborts a nested call that the script did not await", async () => {
		let callSignal: AbortSignal | undefined;
		const definition = createCodemodeToolDefinition({
			getTools: () => [
				{
					name: "slow",
					label: "Slow",
					description: "A slow tool",
					parameters: Type.Object({}),
					execute: async () => ({ content: [], details: undefined }),
				},
			],
			getBranch: () => [],
			appendEntry: () => {},
			executeTool: async (_name, _args, { signal }) => {
				callSignal = signal;
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				throw new Error("aborted");
			},
		});
		const result = await definition.execute(
			"parent",
			{ code: 'tools.slow({}); text("done")' },
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.isError).toBe(false);
		expect(callSignal?.aborted).toBe(true);
		expect(result.details.calls[0].status).toBe("cancelled");
	});

	it("does not commit store writes when an awaited call is cancelled", async () => {
		const controller = new AbortController();
		const writes: CodemodeStoreWrites[] = [];
		let started!: () => void;
		const callStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const definition = createCodemodeToolDefinition({
			getTools: () => [
				{
					name: "slow",
					label: "Slow",
					description: "A slow tool",
					parameters: Type.Object({}),
					execute: async () => ({ content: [], details: undefined }),
				},
			],
			getBranch: () => [],
			appendEntry: (_kind, data) => {
				writes.push(data);
			},
			executeTool: async (_name, _args, { signal }) => {
				started();
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				throw new Error("aborted");
			},
		});
		const pending = definition.execute(
			"parent",
			{ code: 'store("key", "value"); await tools.slow({});' },
			controller.signal,
			undefined,
			undefined as never,
		);
		await callStarted;
		controller.abort();
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(writes).toEqual([]);
	});

	it("concurrent scripts read their start snapshot and commit in completion order", async () => {
		const branch: SessionEntry[] = [];
		const writes: CodemodeStoreWrites[] = [];
		const release = new Map<string, () => void>();
		let bothStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			bothStarted = resolve;
		});
		const definition = createCodemodeToolDefinition({
			getTools: () => [
				{
					name: "pause",
					label: "Pause",
					description: "Wait for a synthetic event",
					parameters: Type.Object({ id: Type.String() }),
					execute: async () => ({ content: [], details: undefined }),
				},
			],
			getBranch: () => branch,
			appendEntry: (kind, data) => {
				writes.push(data);
				branch.push({
					type: "custom",
					id: String(branch.length + 1),
					parentId: branch.at(-1)?.id ?? null,
					timestamp: new Date().toISOString(),
					customType: kind,
					data,
				});
			},
			executeTool: async (name, args) => {
				const id = (args as { id: string }).id;
				await new Promise<void>((resolve) => {
					release.set(id, resolve);
					if (release.size === 2) bothStarted();
				});
				return {
					toolCall: { type: "toolCall", id, name, arguments: args as never },
					result: { content: [], details: undefined },
					isError: false,
				};
			},
		});
		const first = definition.execute(
			"first",
			{ code: 'store("shared", (load("shared") ?? "") + "first"); await tools.pause({id:"first"});' },
			undefined,
			undefined,
			undefined as never,
		);
		const second = definition.execute(
			"second",
			{ code: 'store("shared", (load("shared") ?? "") + "second"); await tools.pause({id:"second"});' },
			undefined,
			undefined,
			undefined as never,
		);
		await started;
		release.get("second")?.();
		await second;
		release.get("first")?.();
		await first;
		expect(writes).toEqual([
			{ set: { shared: "second" }, delete: [] },
			{ set: { shared: "first" }, delete: [] },
		]);
		const resumed = await definition.execute(
			"next",
			{ code: 'text(load("shared"));' },
			undefined,
			undefined,
			undefined as never,
		);
		expect(resumed.content).toEqual([{ type: "text", text: "first" }]);
	});
});
