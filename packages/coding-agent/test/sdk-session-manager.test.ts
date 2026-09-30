import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { getBuiltinModel as getModel } from "@candy/ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { type CreateAgentSessionRuntimeOptions, createAgentSessionRuntime } from "../src/core/runtime-factory.ts";
import { getDefaultSessionDir } from "../src/core/session-history.ts";
import { getTestAgent } from "./execution-internals.ts";
import { createInMemoryModelRuntime } from "./model-runtime-test-utils.ts";
import { assembleTestSession } from "./session-factory.ts";

const runtimes: Awaited<ReturnType<typeof createAgentSessionRuntime>>[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
});
async function assembleAgentSession(options: CreateAgentSessionRuntimeOptions) {
	const runtime = await createAgentSessionRuntime({
		...options,
		modelRuntime: await createInMemoryModelRuntime(AuthStorage.inMemory()),
	});
	runtimes.push(runtime);
	return { session: runtime.session };
}

import { SessionHistory } from "../src/core/session-history.ts";
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
		const sessionDir = session.history.getSessionDir();
		const sessionFile = session.history.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile?.startsWith(`${expectedSessionDir}${sep}`)).toBe(true);
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionHistory.inMemory(cwd);
		const { session } = await assembleAgentSession({
			extensionModules: extensionHostModules,
			themeAdapter: resourceThemeAdapter,
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.history.getSessionId()).toBe(sessionManager.getSessionId());
		expect(session.history.isPersisted()).toBe(false);
		expect(Reflect.get(session.history, "appendMessage")).toBeUndefined();
		expect(Reflect.get(session.execution, "agent")).toBeUndefined();
		expect(Reflect.get(session.execution, "sessionManager")).toBeUndefined();
		expect(Reflect.get(session.selection, "agent")).toBeUndefined();
		expect(Reflect.get(session.resources, "host")).toBeUndefined();
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionHistory.inMemory(sessionCwd);
		const { session } = await assembleAgentSession({
			extensionModules: extensionHostModules,
			themeAdapter: resourceThemeAdapter,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.history.getSessionId()).toBe(sessionManager.getSessionId());
		expect(session.execution.systemPrompt).toContain(`<cwd>\n${sessionCwd.replaceAll("\\", "/")}\n</cwd>`);

		const result = await session.execution.executeBash('node -p "process.cwd()"');
		const output = result.output;

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));
	});

	it("exposes current session state to the built-in bash tool", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await assembleTestSession({
			sessionManager: SessionHistory.create(cwd, getDefaultSessionDir(cwd, agentDir)),
			extensionModules: extensionHostModules,
			themeAdapter: resourceThemeAdapter,
			cwd,
			agentDir,
			model: model!,
			thinkingLevel: "high",
		});
		expect(session.execution.sessionFile).toBeTruthy();
		expect(session.execution.systemPrompt).toContain(
			"You can inspect CANDY_* environment variables for current model and session details.",
		);

		const bashTool = getTestAgent(session.execution).state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", {
			command: `printf '%s\\n' "$CANDY_SESSION_ID" "$CANDY_SESSION_FILE" "$CANDY_PROVIDER" "$CANDY_MODEL" "$CANDY_REASONING_LEVEL"`,
		});
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(output.trim().split("\n")).toEqual([
			session.execution.sessionId,
			session.execution.sessionFile,
			model!.provider,
			model!.id,
			session.selection.thinkingLevel,
		]);
	});
});
