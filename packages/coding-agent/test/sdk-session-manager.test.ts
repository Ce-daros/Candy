import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { getBuiltinModel as getModel } from "@candy/ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleAgentSession } from "../src/core/agent-session-factory.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { extensionHostModules } from "../src/presentation/extensions/virtual-modules.ts";
import { resourceThemeAdapter } from "../src/presentation/resource-theme-adapter.ts";

describe("assembleAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(async () => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await assembleAgentSession({
			extensionModules: extensionHostModules,
			themeAdapter: resourceThemeAdapter,
			cwd,
			agentDir,
			model: model!,
		});

		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const expectedSessionDir = join(agentDir, "sessions", safePath);
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionFile = session.sessionManager.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile?.startsWith(`${expectedSessionDir}${sep}`)).toBe(true);

		await session.dispose();
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await assembleAgentSession({
			extensionModules: extensionHostModules,
			themeAdapter: resourceThemeAdapter,
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		await session.dispose();
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await assembleAgentSession({
			extensionModules: extensionHostModules,
			themeAdapter: resourceThemeAdapter,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`<cwd>\n${sessionCwd.replaceAll("\\", "/")}\n</cwd>`);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", { command: 'node -p "process.cwd()"' });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));

		await session.dispose();
	});

	it("exposes current session state to the built-in bash tool", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await assembleAgentSession({
			extensionModules: extensionHostModules,
			themeAdapter: resourceThemeAdapter,
			cwd,
			agentDir,
			model: model!,
			thinkingLevel: "high",
		});
		expect(session.sessionFile).toBeTruthy();
		expect(session.systemPrompt).toContain(
			"You can inspect CANDY_* environment variables for current model and session details.",
		);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", {
			command: `printf '%s\\n' "$CANDY_SESSION_ID" "$CANDY_SESSION_FILE" "$CANDY_PROVIDER" "$CANDY_MODEL" "$CANDY_REASONING_LEVEL"`,
		});
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(output.trim().split("\n")).toEqual([
			session.sessionId,
			session.sessionFile,
			model!.provider,
			model!.id,
			session.thinkingLevel,
		]);

		await session.dispose();
	});
});
