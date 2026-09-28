import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@candy/ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { extensionHostModules } from "../../../src/presentation/extensions/virtual-modules.ts";
import { resourceThemeAdapter } from "../../../src/presentation/resource-theme-adapter.ts";
import { configuredFauxProvider } from "../../ai.ts";

describe("issue #2753 reload stale resource settings", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	it("applies updated top-level prompt settings on reload after startup", async () => {
		const tempDir = join(tmpdir(), `pi-2753-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		const promptsDir = join(agentDir, "prompts");
		mkdirSync(promptsDir, { recursive: true });
		writeFileSync(join(promptsDir, "test.md"), "Echo test prompt\n");

		const faux = fauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				extensionModules: extensionHostModules,
				themeAdapter: resourceThemeAdapter,
				cwd,
				agentDir,
				modelRuntime,
				resourceLoaderOptions: {
					extensionFactories: [
						(candy) => {
							candy.registerProvider(configuredFauxProvider(faux));
						},
					],
					noSkills: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir,
			sessionManager: SessionManager.create(tempDir),
		});

		cleanups.push(() => {
			runtime.session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		expect(runtime.session.promptTemplates.map((prompt) => prompt.name)).toContain("test");

		writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ prompts: ["-prompts/test.md"] }, null, 2)}\n`);

		await runtime.session.reload();

		expect(runtime.services.settingsManager.getGlobalSettings().prompts).toEqual(["-prompts/test.md"]);
		expect(runtime.session.promptTemplates.map((prompt) => prompt.name)).not.toContain("test");
	});
});
