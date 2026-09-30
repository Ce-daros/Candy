import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinModel as getModel } from "@candy/ai/providers/all";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleAgentSession, type CreateAgentSessionOptions } from "../src/core/agent-session-factory.ts";
import { assembleAgentSessionFromServices, assembleAgentSessionServices } from "../src/core/agent-session-services.ts";
import type { InlineExtension } from "../src/core/extensions/index.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { extensionHostModules } from "../src/presentation/extensions/virtual-modules.ts";
import { resourceThemeAdapter } from "../src/presentation/resource-theme-adapter.ts";

type ToolOptions = Pick<CreateAgentSessionOptions, "tools" | "excludeTools" | "noTools" | "customTools">;

describe("defaultTools setting", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-default-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(async () => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(
		defaultTools: string[],
		options: ToolOptions = {},
		extensionFactories: InlineExtension[] = [],
	) {
		const settingsManager = SettingsManager.inMemory({ defaultTools });
		const resourceLoader = new DefaultResourceLoader({
			extensionModules: extensionHostModules,
			themeAdapter: resourceThemeAdapter,
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		return (
			await assembleAgentSession({
				cwd: tempDir,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager,
				sessionManager: SessionManager.inMemory(tempDir),
				resourceLoader,
				...options,
			})
		).session;
	}

	it("uses the configured list as the initial built-in selection", async () => {
		const session = await createSession(["grep", "find"]);

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);
		expect(session.getActiveToolNames()).toEqual(["grep", "find"]);
		expect(session.systemPrompt).toContain("- grep:");
		expect(session.systemPrompt).not.toContain("- read:");
		await session.dispose();
	});

	it("can select powershell instead of bash", async () => {
		const session = await createSession(["read", "powershell", "edit", "write"]);

		expect(session.getActiveToolNames()).toEqual(["read", "powershell", "edit", "write"]);
		expect(session.systemPrompt).toContain("- powershell: Execute PowerShell commands");
		expect(session.systemPrompt).not.toContain("- bash:");
		await session.dispose();
	});

	it("keeps extension and SDK custom tools enabled", async () => {
		const session = await createSession(
			["grep"],
			{
				customTools: [
					{
						name: "sdk_tool",
						label: "SDK Tool",
						description: "SDK custom tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					},
				],
			},
			[
				(candy) => {
					candy.registerTool({
						name: "static_tool",
						label: "Static Tool",
						description: "Statically registered extension tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
					candy.on("session_start", () => {
						candy.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Dynamically registered extension tool",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
					});
				},
			],
		);
		await session.bindExtensions({});

		expect(session.getActiveToolNames().sort()).toEqual(["dynamic_tool", "grep", "sdk_tool", "static_tool"]);
		expect(session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["read", "dynamic_tool", "sdk_tool", "static_tool"]),
		);
		await session.dispose();
	});

	it("preserves explicit tool option precedence", async () => {
		const allowlistedSession = await createSession(["grep"], { tools: ["read"] });
		expect(allowlistedSession.getActiveToolNames()).toEqual(["read"]);
		allowlistedSession.dispose();

		const excludedSession = await createSession(["read", "grep"], { excludeTools: ["read"] });
		expect(excludedSession.getActiveToolNames()).toEqual(["grep"]);
		excludedSession.dispose();

		const toolLessSession = await createSession(["read"], { noTools: "all" });
		expect(toolLessSession.getAllTools()).toEqual([]);
		expect(toolLessSession.getActiveToolNames()).toEqual([]);
		toolLessSession.dispose();
	});

	it("applies through service-based session creation", async () => {
		const settingsManager = SettingsManager.inMemory({ defaultTools: ["ls"] });
		const services = await assembleAgentSessionServices({
			extensionModules: extensionHostModules,
			themeAdapter: resourceThemeAdapter,
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		const { session } = await assembleAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);
		expect(session.getActiveToolNames()).toEqual(["ls"]);
		await session.dispose();
	});
});
