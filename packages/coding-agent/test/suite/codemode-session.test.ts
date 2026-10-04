import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@candy/ai";
import { afterEach, describe, expect, it } from "vitest";
import { assembleAgentSession } from "../../src/core/agent-session-factory.ts";
import { SessionHistory } from "../../src/core/session-history.ts";
import { createFixtureMcp } from "../mcp-test-utils.ts";
import { createHarness, type Harness } from "./harness.ts";

const lookup = { name: "mcp_fixture_query" };

describe("codemode in session execution", () => {
	const harnesses: Harness[] = [];
	const fixtures = new Map<Harness, Awaited<ReturnType<typeof createFixtureMcp>>>();
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
		for (const fixture of fixtures.values()) await fixture.cleanup();
		fixtures.clear();
	});
	const make = async (options: Parameters<typeof createHarness>[0] = {}) => {
		const fixture = await createFixtureMcp();
		const harness = await createHarness({
			mcp: fixture.runtime,
			allowedToolNames: [lookup.name],
			initialActiveToolNames: [lookup.name],
			...options,
		});
		fixtures.set(harness, fixture);
		harnesses.push(harness);
		return harness;
	};
	const run = async (h: Harness, code: string) => {
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.execution.prompt("run script");
		return h.session.execution.messages.filter((message) => message.role === "toolResult").at(-1);
	};

	it("automatically exposes codemode, hides MCP declarations, and commits only the parent result", async () => {
		const h = await make();
		expect(h.session.execution.getActiveToolNames()).toEqual([lookup.name, "codemode", "search_mcp_tools"]);
		expect(h.session.execution.state.tools.map((tool) => tool.name)).toEqual(["codemode", "search_mcp_tools"]);
		expect(h.session.execution.systemPrompt).toContain("Use search_mcp_tools to discover declarations");
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("search_mcp_tools", { query: "record" }), { stopReason: "toolUse" }),
			(context) => {
				const search = context.messages.filter((m) => m.role === "toolResult").at(-1);
				expect(JSON.stringify(search)).toContain("mcp_fixture_query");
				expect(JSON.stringify(search)).toContain("id: number");
				return fauxAssistantMessage(
					fauxToolCall("codemode", {
						code: "const r = await tools.mcp_fixture_query({id:2}); text(r.structuredContent.amount);",
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("done"),
		]);
		await h.session.execution.prompt("discover and run MCP query");
		const result = h.session.execution.messages.filter((m) => m.role === "toolResult").at(-1);
		expect(result?.content).toEqual([{ type: "text", text: "20" }]);
		expect(h.session.execution.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(JSON.stringify(h.session.execution.messages)).not.toContain('\\"amount\\":20');
		const nested = h.eventsOfType("tool_execution_start").find((event) => event.toolName === lookup.name);
		expect(nested?.parentToolCallId).toBeDefined();
	});

	it("applies extension blocking to nested calls", async () => {
		const h = await make({
			extensionFactories: [
				(candy) => {
					candy.on("tool_call", (event) =>
						event.parentToolCallId ? { block: true, reason: "Blocked nested call" } : undefined,
					);
				},
			],
		});
		const result = await run(h, `text(await tools.${lookup.name}({id:1}));`);
		expect(h.eventsOfType("tool_execution_end").find((event) => event.toolName === lookup.name)).toMatchObject({
			isError: true,
		});
		expect(result?.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("Blocked nested call");
	});

	it("cannot bypass excluded tools or an explicit codemode disable", async () => {
		const h = await make({ excludedToolNames: [lookup.name], initialActiveToolNames: ["codemode"] });
		const result = await run(h, `text(await tools.${lookup.name}({id:1}));`);
		expect(result?.isError).toBe(true);
		h.session.execution.setActiveToolsByName([]);
		expect(h.session.execution.state.tools).toEqual([]);
	});

	it("uses structured result hook overrides in scripts", async () => {
		const h = await make({
			extensionFactories: [
				(candy) => {
					candy.on("tool_result", (event) =>
						event.parentToolCallId ? { structuredContent: { value: 77 } } : undefined,
					);
				},
			],
		});
		const result = await run(h, `text((await tools.${lookup.name}({id:1})).value);`);
		expect(result?.content).toEqual([{ type: "text", text: "77" }]);
	});

	it("reenables MCP access after a temporary loadout and respects later explicit disabling", async () => {
		const h = await make({
			extensionFactories: [
				(candy) => {
					candy.on("before_agent_start", (event) => {
						event.systemPromptOptions.selectedTools = [];
					});
				},
			],
		});
		await h.session.execution.bindExtensions({});
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.execution.prompt("temporary loadout");
		expect(h.session.execution.state.tools).toEqual([]);
		h.session.execution.setActiveToolsByName([lookup.name]);
		expect(h.session.execution.state.tools.map((tool) => tool.name)).toEqual(["codemode", "search_mcp_tools"]);
		h.session.execution.setActiveToolsByName([lookup.name]);
		expect(h.session.execution.state.tools).toEqual([]);
		await h.session.execution.reload();
		expect(h.session.execution.getActiveToolNames()).toEqual([lookup.name]);
		expect(h.session.execution.state.tools).toEqual([]);
	});

	it("rejects schema errors before executing a nested tool", async () => {
		const h = await make();
		const result = await run(h, `text(await tools.${lookup.name}({id:"bad"}));`);
		expect(h.eventsOfType("tool_execution_end").find((event) => event.toolName === lookup.name)).toMatchObject({
			isError: true,
		});
		expect(JSON.stringify(result)).toContain("id");
		expect(result?.isError).toBe(true);
	});

	it("respects direct MCP exposure without adding codemode", async () => {
		const h = await make();
		await fixtures.get(h)!.runtime.setExposure("fixture", "direct");
		expect(h.session.execution.state.tools.map((tool) => tool.name)).toEqual([lookup.name]);
	});

	it("restores successful store writes and keeps branch writes isolated", async () => {
		const h = await make();
		await run(h, 'store("answer", 42);');
		const firstLeaf = h.sessionManager.getLeafId()!;
		await run(h, 'store("answer", 99); throw Error("failed");');
		const file = h.sessionManager.exportToJsonl(join(h.tempDir, "resume.jsonl"));
		const { session: resumed } = await assembleAgentSession({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.modelRuntime,
			settingsManager: h.settingsManager,
			resourceLoader: h.session.execution.resourceLoader,
			sessionManager: SessionHistory.open(file),
			model: h.getModel(),
			mcp: fixtures.get(h)!.runtime,
		});
		try {
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("codemode", { code: 'text(load("answer"));' }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await resumed.execution.prompt("restore");
			expect(resumed.execution.messages.filter((m) => m.role === "toolResult").at(-1)?.content).toEqual([
				{ type: "text", text: "42" },
			]);
		} finally {
			await resumed.execution.dispose();
		}
		await run(h, 'store("answer", 7);');
		h.sessionManager.branch(firstLeaf);
		const result = await run(h, 'text(load("answer"));');
		expect(result?.content).toEqual([{ type: "text", text: "42" }]);
	});
});
