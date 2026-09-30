import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinModel as getModel } from "@candy/ai/providers/all";
import { describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionHistory } from "../src/core/session-history.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createAllToolDefinitions, createAllTools } from "../src/core/tools/index.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { extensionHostModules } from "../src/presentation/extensions/virtual-modules.ts";
import { resourceThemeAdapter } from "../src/presentation/resource-theme-adapter.ts";
import { getTestAgent } from "./execution-internals.ts";
import { assembleTestSession as assembleAgentSession } from "./session-factory.ts";

const strictToolNames = ["read", "bash", "powershell", "edit", "write"] as const;

describe("strict built-in tools", () => {
	it("prefers strict sampling for built-in tools", async () => {
		const definitions = createAllToolDefinitions(process.cwd());
		const tools = createAllTools(process.cwd());
		for (const name of strictToolNames) {
			expect(definitions[name].constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
			expect(tools[name].constrainedSampling).toEqual(definitions[name].constrainedSampling);
		}
		for (const name of ["grep", "find", "ls"] as const) {
			expect(definitions[name].constrainedSampling).toBeUndefined();
		}
		// Strictness is a provider-side conversion, not a change to the execution schema.
		expect(definitions.read.parameters.required).toEqual(["path"]);
		expect(definitions.bash.parameters.required).toEqual(["command"]);
	});

	it("preserves explicit opt-outs when wrapping definitions for execution", async () => {
		const definitions = createAllToolDefinitions(process.cwd());
		for (const name of strictToolNames) {
			const definition = definitions[name];
			const override = { ...definition, constrainedSampling: false as const };
			expect(wrapToolDefinition(override).constrainedSampling).toBe(false);
			expect(override.execute).toBe(definition.execute);
			expect(override.prepareArguments).toBe(definition.prepareArguments);
			expect(override.promptGuidelines).toBe(definition.promptGuidelines);
			expect(definition.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
		}
	});

	it.each([{ activeTools: [] }, { activeTools: ["read"] }, { activeTools: [...strictToolNames] }])(
		"allows extensions to re-register tools without strict sampling: $activeTools",
		async ({ activeTools }) => {
			const cwd = mkdtempSync(join(tmpdir(), "pi-non-strict-tools-"));
			const agentDir = join(cwd, "agent");
			const settingsManager = SettingsManager.inMemory({ defaultTools: activeTools });
			const resourceLoader = new DefaultResourceLoader({
				extensionModules: extensionHostModules,
				themeAdapter: resourceThemeAdapter,
				cwd,
				agentDir,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(candy) => {
						candy.on("session_start", () => {
							const definitions = createAllToolDefinitions(cwd);
							for (const name of strictToolNames) {
								candy.registerTool({ ...definitions[name], constrainedSampling: false });
							}
							candy.setActiveTools(activeTools);
						});
					},
				],
			});
			try {
				await resourceLoader.reload();
				const { session } = await assembleAgentSession({
					cwd,
					agentDir,
					model: getModel("anthropic", "claude-sonnet-4-5"),
					settingsManager,
					sessionManager: SessionHistory.inMemory(cwd),
					resourceLoader,
				});
				try {
					const originalPrompt = session.execution.systemPrompt;
					await session.execution.bindExtensions({});
					expect(session.execution.getActiveToolNames()).toEqual(activeTools);
					expect(session.execution.systemPrompt).toBe(originalPrompt);
					for (const name of strictToolNames) {
						expect(session.execution.getToolDefinition(name)?.constrainedSampling).toBe(false);
					}
					for (const tool of getTestAgent(session.execution).state.tools) {
						expect(tool.constrainedSampling).toBe(false);
					}
					if (activeTools.includes("read")) {
						writeFileSync(join(cwd, "sample.txt"), "still works");
						const read = getTestAgent(session.execution).state.tools.find((tool) => tool.name === "read")!;
						const result = await read.execute("read-test", { path: "sample.txt" });
						expect(result.content).toEqual([{ type: "text", text: "still works" }]);
					}
				} finally {
					await session.execution.dispose();
				}
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		},
	);
});
