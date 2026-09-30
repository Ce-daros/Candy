import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@candy/ai";
import { getBuiltinModel as getModel } from "@candy/ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionHistory } from "../src/core/session-history.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { extensionHostModules } from "../src/presentation/extensions/virtual-modules.ts";
import { resourceThemeAdapter } from "../src/presentation/resource-theme-adapter.ts";
import { getTestAgent } from "./execution-internals.ts";
import { assembleTestSession as assembleAgentSession } from "./session-factory.ts";

function nativeAnthropicProvider(baseUrl: string): Provider {
	const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, baseUrl };
	return {
		id: "anthropic",
		name: "Native Anthropic",
		baseUrl,
		auth: {
			apiKey: {
				name: "Test API key",
				resolve: async () => ({ auth: { apiKey: "test-key" }, source: "test" }),
			},
		},
		getModels: () => [model],
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

describe("AgentSession dynamic provider registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-dynamic-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(async () => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(extensionFactories: ExtensionFactory[]) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionHistory.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		const resourceLoader = new DefaultResourceLoader({
			extensionModules: extensionHostModules,
			themeAdapter: resourceThemeAdapter,
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		const { session } = await assembleAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			modelRuntime,
			resourceLoader,
		});

		return session;
	}

	async function capturePromptBaseUrl(
		session: Awaited<ReturnType<typeof createSession>>,
	): Promise<string | undefined> {
		let baseUrl: string | undefined;
		getTestAgent(session.execution).streamFunction = async (model) => {
			baseUrl = model.baseUrl;
			throw new Error("stop");
		};
		await session.execution.prompt("hello");
		return baseUrl;
	}

	it("installs a native provider registered from session_start", async () => {
		const session = await createSession([
			(candy) => {
				candy.on("session_start", () => {
					candy.registerProvider(nativeAnthropicProvider("http://localhost:8080/session-start"));
				});
			},
		]);

		await session.execution.bindExtensions({});

		expect(session.selection.model?.baseUrl).toBe("http://localhost:8080/session-start");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/session-start");

		await session.execution.dispose();
	});

	it("registers native pi-ai providers during extension loading", async () => {
		const session = await createSession([
			(candy) => {
				candy.registerProvider(nativeAnthropicProvider("http://localhost:8080/native-top-level"));
			},
		]);

		expect(session.execution.modelRuntime.getRegisteredProviderIds()).toContain("anthropic");
		expect(session.execution.modelRuntime.getModel("anthropic", "claude-sonnet-4-5")?.baseUrl).toBe(
			"http://localhost:8080/native-top-level",
		);

		await session.execution.dispose();
	});

	it("installs a native provider registered from a command", async () => {
		const session = await createSession([
			(candy) => {
				candy.registerCommand("use-proxy", {
					description: "Use proxy",
					handler: async () => {
						candy.registerProvider(nativeAnthropicProvider("http://localhost:8080/command"));
					},
				});
			},
		]);

		await session.execution.bindExtensions({});
		await session.execution.executeCommand({ source: "extension", name: "use-proxy", args: "" });

		expect(session.selection.model?.baseUrl).toBe("http://localhost:8080/command");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/command");

		await session.execution.dispose();
	});

	it("registers native pi-ai providers at command time", async () => {
		const session = await createSession([
			(candy) => {
				candy.registerCommand("use-native", {
					description: "Use native provider",
					handler: async () => {
						candy.registerProvider(nativeAnthropicProvider("http://localhost:8080/native-command"));
					},
				});
			},
		]);

		await session.execution.bindExtensions({});
		await session.execution.executeCommand({ source: "extension", name: "use-native", args: "" });

		expect(session.selection.model?.baseUrl).toBe("http://localhost:8080/native-command");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/native-command");

		await session.execution.dispose();
	});
});
