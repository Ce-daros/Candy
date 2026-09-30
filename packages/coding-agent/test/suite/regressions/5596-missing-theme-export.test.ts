import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@candy/ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import type { SessionExecutionConfig } from "../../../src/core/session-execution.ts";
import { SessionHistory } from "../../../src/core/session-history.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { exportSessionHtml } from "../../../src/presentation/session-html-export.ts";
import { configuredFauxProvider } from "../../ai.ts";
import { createInMemoryModelRuntime } from "../../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../../utilities.ts";

describe("regression #5596: missing configured theme export", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
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
		const sessionManager = SessionHistory.create(tempDir, join(tempDir, "sessions"));
		const agentOptions: SessionExecutionConfig["agentOptions"] = {
			getApiKey: () => "faux-key",
			initialState: {
				model,

				tools: [],
			},
			convertToLlm,
			streamFn: faux.provider.streamSimple,
		};
		const session = new AgentSession({
			agentOptions,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: modelRuntime,
			resourceLoader: createTestResourceLoader(),
		});
		cleanups.push(async () => {
			await session.execution.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await session.execution.prompt("hi");
		initTheme(settingsManager.getTheme());

		const outputPath = join(tempDir, "export.html");
		await expect(exportSessionHtml(session, outputPath)).resolves.toBe(outputPath);
		expect(existsSync(outputPath)).toBe(true);
		expect(settingsManager.getTheme()).toBe("missing-theme");
	});
});
