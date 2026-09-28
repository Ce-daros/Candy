import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@candy/agent-core";
import { fauxAssistantMessage, fauxProvider } from "@candy/ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { exportSessionHtml } from "../../../src/presentation/session-html-export.ts";
import { configuredFauxProvider } from "../../ai.ts";
import { createInMemoryModelRuntime } from "../../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../../utilities.ts";

describe("regression #5596: missing configured theme export", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
		initTheme("dark");
	});

	it("exports with the active fallback theme when the configured theme is missing", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-5596-"));
		const faux = fauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		faux.setResponses([fauxAssistantMessage("hello")]);

		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await createInMemoryModelRuntime(authStorage);
		modelRuntime.registerNativeProvider(configuredFauxProvider(faux));

		const settingsManager = SettingsManager.inMemory({ theme: "missing-theme" });
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const agent = new Agent({
			getApiKey: () => "faux-key",
			initialState: {
				model,
				systemPrompt: "You are a test assistant.",
				tools: [],
			},
			convertToLlm,
			streamFn: faux.provider.streamSimple,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: modelRuntime,
			resourceLoader: createTestResourceLoader(),
		});
		cleanups.push(() => {
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await session.prompt("hi");
		initTheme(settingsManager.getTheme());

		const outputPath = join(tempDir, "export.html");
		await expect(exportSessionHtml(session, outputPath)).resolves.toBe(outputPath);
		expect(existsSync(outputPath)).toBe(true);
		expect(settingsManager.getTheme()).toBe("missing-theme");
	});
});
