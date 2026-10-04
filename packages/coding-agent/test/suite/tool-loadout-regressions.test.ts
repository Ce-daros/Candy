import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionRuntime, SessionHistory, SettingsManager } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("tool allowlists and built-in suppression", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	async function createSession(options: { tools?: string[]; noTools?: "all" | "builtin" } = {}) {
		const harness = await createHarness({
			allowedToolNames: options.noTools === "all" ? [] : options.tools,
			initialActiveToolNames: options.noTools ? [] : undefined,
			extensionFactories: [
				(candy) => {
					candy.on("session_start", () => {
						candy.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Tool registered from session_start",
							promptSnippet: "Run dynamic test behavior",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.execution.bindExtensions({});
		return harness;
	}

	it("#2835 enables only explicitly allowed built-in and extension tools", async () => {
		const { session } = await createSession({ tools: ["read", "dynamic_tool"] });
		expect(
			session.execution
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["codemode", "dynamic_tool", "read", "search_mcp_tools"]);
		expect(session.execution.getActiveToolNames().sort()).toEqual(["dynamic_tool", "read"]);
		expect(session.execution.systemPrompt).toContain("- read: Read file contents");
		expect(session.execution.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		expect(session.execution.systemPrompt).not.toContain("- bash:");
		expect(session.execution.systemPrompt).not.toContain("- edit:");
	});

	it.each([{ tools: [] }, { noTools: "all" as const }])("disables every tool with %j", async (options) => {
		const { session } = await createSession(options);
		expect(session.execution.getAllTools()).toEqual([]);
		expect(session.execution.getActiveToolNames()).toEqual([]);
		expect(session.execution.systemPrompt).toContain("<tools>\n(none)\n");
		expect(session.execution.systemPrompt).not.toContain("dynamic_tool");
	});

	it("#3592 retains extension tools when built-in defaults are disabled", async () => {
		const { session } = await createSession({ noTools: "builtin" });
		expect(session.execution.getActiveToolNames()).toEqual(["dynamic_tool"]);
		expect(
			session.execution
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual([
			"bash",
			"codemode",
			"dynamic_tool",
			"edit",
			"find",
			"grep",
			"ls",
			"powershell",
			"read",
			"search_mcp_tools",
			"write",
		]);
		expect(session.execution.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		expect(session.execution.systemPrompt).not.toContain("- read:");
		expect(session.execution.systemPrompt).not.toContain("- bash:");
	});

	it("applies suppression through the public SDK runtime constructor", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const runtime = await createAgentSessionRuntime({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.execution.modelRuntime,
			model: harness.getModel(),
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionHistory.inMemory(harness.tempDir),
			noTools: "builtin",
		});
		try {
			expect(runtime.session.resources.getActiveTools()).toEqual([]);
			expect(runtime.session.execution.systemPrompt).toContain("<tools>\n(none)\n");
		} finally {
			await runtime.dispose();
		}
	});
});
