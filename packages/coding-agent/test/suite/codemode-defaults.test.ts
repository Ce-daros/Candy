import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@candy/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { assembleAgentSession, type CreateAgentSessionOptions } from "../../src/core/agent-session-factory.ts";
import { CODEMODE_ENABLED_ENTRY_TYPE } from "../../src/core/codemode-tool.ts";
import { createAgentSessionRuntime } from "../../src/core/runtime-factory.ts";
import { SessionHistory } from "../../src/core/session-history.ts";
import type { CustomEntry } from "../../src/core/session-records.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createFixtureMcp } from "../mcp-test-utils.ts";
import { createHarness, type Harness } from "./harness.ts";

function selections(history: SessionHistory) {
	return history
		.getBranch()
		.filter(
			(entry): entry is CustomEntry => entry.type === "custom" && entry.customType === CODEMODE_ENABLED_ENTRY_TYPE,
		);
}

describe("codemode defaults and saved selection", () => {
	const cleanups: Array<() => Promise<void>> = [];
	const fixtures = new Map<Harness, Awaited<ReturnType<typeof createFixtureMcp>>>();
	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
		fixtures.clear();
	});

	async function make(options: Parameters<typeof createHarness>[0] = {}, withMcp = true) {
		const fixture = withMcp ? await createFixtureMcp() : undefined;
		if (fixture) cleanups.push(fixture.cleanup);
		const h = await createHarness({ mcp: fixture?.runtime, ...options });
		if (fixture) {
			fixtures.set(h, fixture);
			writeFileSync(join(h.tempDir, "mcp.json"), JSON.stringify(fixture.config));
		}
		cleanups.push(h.cleanup);
		return h;
	}

	async function assemble(h: Harness, options: Partial<CreateAgentSessionOptions> = {}) {
		const result = await assembleAgentSession({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.modelRuntime,
			model: h.getModel(),
			mcp: fixtures.get(h)?.runtime,
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: h.session.execution.resourceLoader,
			sessionManager: SessionHistory.inMemory(h.tempDir),
			...options,
		});
		cleanups.push(() => result.session.execution.dispose());
		return result.session;
	}

	it("keeps ordinary factory and public SDK defaults without MCP on the four builtin tools", async () => {
		const h = await make({}, false);
		expect(h.session.execution.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		expect(h.session.execution.systemPrompt).toContain(
			"Use bash for standalone calculations and local data processing",
		);
		expect(h.session.execution.systemPrompt).not.toContain("Use codemode");
		expect(h.session.execution.systemPrompt).not.toContain("search_mcp_tools");
		const runtime = await createAgentSessionRuntime({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.modelRuntime,
			model: h.getModel(),
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionHistory.inMemory(h.tempDir),
			resourceLoaderFactory: () => h.session.execution.resourceLoader,
		});
		cleanups.push(() => runtime.dispose());
		expect(runtime.session.resources.getActiveTools()).toEqual(["read", "bash", "edit", "write"]);
	});

	it.each([
		{ tools: ["read"] },
		{ tools: [] },
		{ tools: ["codemode"] },
		{ tools: ["search_mcp_tools"] },
		{ initialActiveToolNames: ["read"] },
		{ initialActiveToolNames: [] },
		{ settingsManager: SettingsManager.inMemory({ defaultTools: ["read"] }) },
		{ settingsManager: SettingsManager.inMemory({ defaultTools: [] }) },
		{ baseToolsOverride: {} },
		{ noTools: "all" as const },
		{ noTools: "builtin" as const },
		{ excludeTools: ["codemode"] },
	])("respects explicit tool configuration %j", async (options: Partial<CreateAgentSessionOptions>) => {
		const h = await make({}, false);
		const session = await assemble(h, options);
		expect(session.execution.getActiveToolNames()).not.toContain("codemode");
		expect(session.execution.systemPrompt).not.toContain("Prefer codemode");
		if (options.noTools === "all" || options.tools?.length === 0) {
			expect(session.execution.getAllTools()).toEqual([]);
		}
	});

	it("aggregates and transforms MCP results inside the script", async () => {
		const h = await make();
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: "const records = await Promise.all([3,1,3,2].map(id => tools.mcp_fixture_query({id}))); const values = [...new Set(records.map(r => r.structuredContent.amount))].sort((a,b) => a-b); text({values, total: values.reduce((sum,n) => sum+n,0)});",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await h.session.execution.prompt("calculate and transform");
		const result = h.session.execution.messages.filter((message) => message.role === "toolResult").at(-1);
		expect(result?.isError).toBe(false);
		expect(result?.content).toEqual([
			{
				type: "text",
				text: JSON.stringify({
					values: [10, 20, 30],
					total: 60,
				}),
			},
		]);
		expect(h.eventsOfType("tool_execution_start").map((event) => event.toolName)).toEqual([
			"codemode",
			...Array(4).fill("mcp_fixture_query"),
		]);
	});

	it("keeps MCP codemode dependencies available with builtin suppression, but honors exclusion", async () => {
		const h = await make();
		const customTools = [
			{
				name: "lookup",
				label: "Lookup",
				description: "Synthetic MCP lookup",
				parameters: Type.Object({}),
				exposure: "codemode" as const,
				execute: async () => ({ content: [], details: undefined }),
			},
		];
		const enabled = await assemble(h, { noTools: "builtin" });
		expect(enabled.execution.getActiveToolNames()).toEqual([
			"mcp_fixture_query",
			"mcp_fixture_media",
			"codemode",
			"search_mcp_tools",
		]);
		const sdkOnly = await assemble(h, { noTools: "builtin", customTools, mcp: undefined });
		expect(sdkOnly.execution.getActiveToolNames()).toEqual(["lookup"]);
		const excluded = await assemble(h, { customTools, excludeTools: ["codemode"] });
		expect(excluded.execution.getActiveToolNames()).not.toContain("codemode");
		expect(excluded.execution.getActiveToolNames()).not.toContain("search_mcp_tools");
		const searchExcluded = await assemble(h, { excludeTools: ["search_mcp_tools"] });
		expect(searchExcluded.execution.getActiveToolNames()).toContain("codemode");
		expect(searchExcluded.execution.getActiveToolNames()).not.toContain("search_mcp_tools");
		const allDisabled = await assemble(h, { customTools, noTools: "all" });
		expect(allDisabled.execution.getAllTools()).toEqual([]);
	});

	it("cannot discover or invoke builtins or inactive MCP tools", async () => {
		const h = await make({ allowedToolNames: ["read", "mcp_fixture_query", "codemode"] });
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("search_mcp_tools", { query: "fixture record image read" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: 'text("read" in tools); text("mcp_fixture_media" in tools); text("search_mcp_tools" in tools); text(typeof ALL_TOOLS);',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await h.session.execution.prompt("inspect available tools");
		const result = h.session.execution.messages.filter((message) => message.role === "toolResult").at(-1);
		expect(result?.content).toEqual([
			{ type: "text", text: "false" },
			{ type: "text", text: "false" },
			{ type: "text", text: "false" },
			{ type: "text", text: "undefined" },
		]);
		const searchResult = h.session.execution.messages.find((message) => message.role === "toolResult");
		expect(JSON.parse(searchResult!.content.find((item) => item.type === "text")!.text)).toMatchObject({
			tools: [{ name: "mcp_fixture_query" }],
		});
		expect(h.eventsOfType("tool_execution_start").map((event) => event.toolName)).toEqual([
			"search_mcp_tools",
			"codemode",
		]);
	});

	it("persists explicit disabling and reenabling, emits entries, and survives reload and restore", async () => {
		const h = await make();
		const defaults = h.session.execution.getActiveToolNames();
		const disabled = defaults.filter((name) => name !== "codemode");
		h.session.execution.setActiveToolsByName(disabled);
		h.session.execution.setActiveToolsByName(disabled);
		expect(h.session.execution.systemPrompt).not.toContain("search_mcp_tools");
		expect(selections(h.sessionManager).map((entry) => entry.data)).toEqual([{ enabled: false }]);
		expect(
			h
				.eventsOfType("entry_appended")
				.filter((event) => event.entry.type === "custom" && event.entry.customType === CODEMODE_ENABLED_ENTRY_TYPE),
		).toHaveLength(1);
		await h.session.execution.reload();
		expect(h.session.execution.getActiveToolNames()).not.toContain("codemode");
		const disabledFile = h.sessionManager.exportToJsonl(join(h.tempDir, "disabled.jsonl"));
		const resumedDisabled = await assemble(h, { sessionManager: SessionHistory.open(disabledFile) });
		expect(resumedDisabled.execution.getActiveToolNames()).not.toContain("codemode");
		h.session.execution.setActiveToolsByName(defaults);
		h.session.execution.setActiveToolsByName(defaults);
		expect(selections(h.sessionManager).map((entry) => entry.data)).toEqual([{ enabled: false }, { enabled: true }]);
		const enabledFile = h.sessionManager.exportToJsonl(join(h.tempDir, "enabled.jsonl"));
		const resumedEnabled = await assemble(h, { sessionManager: SessionHistory.open(enabledFile) });
		expect(resumedEnabled.execution.getActiveToolNames()).toContain("codemode");
		const explicitDisabled = await assemble(h, { sessionManager: SessionHistory.open(enabledFile), tools: ["read"] });
		expect(explicitDisabled.execution.getActiveToolNames()).toEqual(["read"]);
		const explicitEnabled = await assemble(h, {
			sessionManager: SessionHistory.open(disabledFile),
			tools: ["codemode", "mcp_fixture_query"],
		});
		expect(explicitEnabled.execution.getActiveToolNames()).toEqual([
			"mcp_fixture_query",
			"codemode",
			"search_mcp_tools",
		]);
	});

	it("keeps an enabled preference while no MCP tools are available, and reapplies it on reconnection", async () => {
		const h = await make();
		const mcp = fixtures.get(h)!.runtime;
		await mcp.setEnabled("fixture", false);
		expect(h.session.execution.getActiveToolNames()).not.toContain("codemode");
		expect(selections(h.sessionManager)).toEqual([]);
		h.session.resources.setActiveTools(["read", "codemode"]);
		h.session.resources.setActiveTools(["read", "codemode"]);
		expect(h.session.resources.getActiveTools()).toEqual(["read"]);
		expect(selections(h.sessionManager).map((entry) => entry.data)).toEqual([{ enabled: true }]);
		await h.session.execution.reload();
		expect(h.session.resources.getActiveTools()).not.toContain("codemode");
		await mcp.setEnabled("fixture", true);
		expect(h.session.resources.getActiveTools()).toContain("codemode");
		h.session.resources.setActiveTools(h.session.resources.getActiveTools().filter((name) => name !== "codemode"));
		await mcp.reconnect("fixture");
		expect(h.session.resources.getActiveTools()).not.toContain("codemode");
	});

	it("does not grant script access to SDK or extension tools with codemode exposure", async () => {
		const h = await make({
			extensionFactories: [
				(candy) => {
					candy.registerTool({
						name: "extension_lookup",
						label: "Extension lookup",
						description: "Extension item lookup",
						parameters: Type.Object({}),
						exposure: "codemode",
						execute: async () => ({ content: [], details: undefined }),
					});
				},
			],
		});
		const customTools = [
			{
				name: "sdk_lookup",
				label: "SDK lookup",
				description: "SDK item lookup",
				parameters: Type.Object({}),
				exposure: "codemode" as const,
				execute: async () => ({ content: [], details: undefined }),
			},
		];
		const session = await assemble(h, { customTools });
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: 'text("sdk_lookup" in tools); text("bash" in tools); text("extension_lookup" in tools);',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await session.execution.prompt("inspect script permissions");
		expect(session.execution.messages.filter((m) => m.role === "toolResult").at(-1)?.content).toEqual([
			{ type: "text", text: "false" },
			{ type: "text", text: "false" },
			{ type: "text", text: "false" },
		]);
		await fixtures.get(h)!.runtime.setExposure("fixture", "direct");
		expect(session.execution.state.tools.map((tool) => tool.name)).not.toContain("codemode");
	});

	it("adds codemode to old transcript loadouts with no explicit saved choice", async () => {
		const h = await make({ initialActiveToolNames: ["read"] }, false);
		h.setResponses([fauxAssistantMessage("old response")]);
		await h.session.execution.prompt("old session");
		expect(selections(h.sessionManager)).toEqual([]);
		const file = h.sessionManager.exportToJsonl(join(h.tempDir, "old.jsonl"));
		const fixture = await createFixtureMcp();
		cleanups.push(fixture.cleanup);
		const resumed = await assemble(h, { mcp: fixture.runtime, sessionManager: SessionHistory.open(file) });
		expect(resumed.execution.getActiveToolNames()).toEqual([
			"read",
			"mcp_fixture_query",
			"mcp_fixture_media",
			"codemode",
			"search_mcp_tools",
		]);
	});

	it("reads the choice from the navigated branch", async () => {
		const h = await make();
		const defaults = h.session.execution.getActiveToolNames();
		h.session.execution.setActiveToolsByName(defaults.filter((name) => name !== "codemode"));
		const disabledId = h.sessionManager.getLeafId()!;
		h.session.execution.setActiveToolsByName(defaults);
		const enabledId = h.sessionManager.getLeafId()!;
		await h.session.execution.navigateTree(disabledId);
		expect(h.session.execution.getActiveToolNames()).not.toContain("codemode");
		await h.session.execution.navigateTree(enabledId);
		expect(h.session.execution.getActiveToolNames()).toContain("codemode");
	});

	it("preserves SDK selection through fork, switch, and import, and resets for a new session", async () => {
		const h = await make();
		const runtime = await createAgentSessionRuntime({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.modelRuntime,
			model: h.getModel(),
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionHistory.inMemory(h.tempDir),
			resourceLoaderFactory: () => h.session.execution.resourceLoader,
		});
		cleanups.push(() => runtime.dispose());
		runtime.session.resources.setActiveTools(["read"]);
		const disabledLeaf = runtime.session.history.getLeafId()!;
		const file = runtime.session.history.exportToJsonl(join(h.tempDir, "sdk-disabled.jsonl"));
		await runtime.fork(disabledLeaf, { position: "at" });
		expect(runtime.session.resources.getActiveTools()).not.toContain("codemode");
		await runtime.newSession();
		expect(runtime.session.resources.getActiveTools()).toContain("codemode");
		await runtime.switchSession(file);
		expect(runtime.session.resources.getActiveTools()).not.toContain("codemode");
		await runtime.newSession();
		await runtime.importFromJsonl(file);
		expect(runtime.session.resources.getActiveTools()).not.toContain("codemode");
	});

	it("persists an extension's explicit tool selection", async () => {
		const h = await make({
			extensionFactories: [
				(candy) => {
					candy.registerCommand("disable-codemode", {
						description: "Disable codemode explicitly",
						handler: async () => {
							candy.setActiveTools(["read"]);
						},
					});
				},
			],
		});
		await h.session.execution.executeCommand({ source: "extension", name: "disable-codemode", args: "" });
		expect(h.session.execution.getActiveToolNames()).toEqual(["read"]);
		expect(selections(h.sessionManager).map((entry) => entry.data)).toEqual([{ enabled: false }]);
	});

	it("does not persist request-level selectedTools changes", async () => {
		const h = await make({
			extensionFactories: [
				(candy) => {
					candy.on("before_agent_start", (event) => {
						event.systemPromptOptions.selectedTools = ["read"];
					});
				},
			],
		});
		await h.session.execution.bindExtensions({});
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.execution.prompt("temporary loadout");
		expect(selections(h.sessionManager)).toEqual([]);
		const file = h.sessionManager.exportToJsonl(join(h.tempDir, "temporary.jsonl"));
		const resumed = await assemble(h, { sessionManager: SessionHistory.open(file) });
		expect(resumed.execution.getActiveToolNames()).toContain("codemode");
	});

	it("does not offer an empty codemode entry through request-level selectedTools", async () => {
		const h = await make(
			{
				extensionFactories: [
					(candy) => {
						candy.on("before_agent_start", (event) => {
							event.systemPromptOptions.selectedTools = ["codemode"];
						});
					},
				],
			},
			false,
		);
		await h.session.execution.bindExtensions({});
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.execution.prompt("temporary codemode selection");
		expect(h.session.execution.state.tools).toEqual([]);
		expect(h.session.execution.systemPrompt).not.toContain("Use codemode");
		expect(selections(h.sessionManager)).toEqual([]);
	});

	it("persists an explicit disable after the request already disabled codemode temporarily", async () => {
		const h = await make({
			extensionFactories: [
				(candy) => {
					candy.on("before_agent_start", (event) => {
						event.systemPromptOptions.selectedTools = ["read"];
					});
				},
			],
		});
		await h.session.execution.bindExtensions({});
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.execution.prompt("temporary loadout");
		expect(selections(h.sessionManager)).toEqual([]);
		h.session.resources.setActiveTools(["read"]);
		h.session.resources.setActiveTools(["read"]);
		expect(selections(h.sessionManager).map((entry) => entry.data)).toEqual([{ enabled: false }]);
		const file = h.sessionManager.exportToJsonl(join(h.tempDir, "explicit-after-temporary.jsonl"));
		const resumed = await assemble(h, { sessionManager: SessionHistory.open(file) });
		expect(resumed.execution.getActiveToolNames()).not.toContain("codemode");
	});
});
