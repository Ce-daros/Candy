import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	normalizeContext,
	type Provider,
	type SimpleStreamOptions,
} from "@candy/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionHistory } from "../src/core/session-history.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { extensionHostModules } from "../src/presentation/extensions/virtual-modules.ts";
import { resourceThemeAdapter } from "../src/presentation/resource-theme-adapter.ts";
import { getTestAgent } from "./execution-internals.ts";
import { createTestModelRuntime } from "./model-runtime-test-utils.ts";
import { assembleTestSession as assembleAgentSession } from "./session-factory.ts";

describe("assembleAgentSession stream options", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-stream-options-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(async () => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(api: Api): Model<Api> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			headers: { "x-model": "model" },
		};
	}

	function createDoneMessage(api: Api, promptTokens = 0): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api,
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: promptTokens,
				cacheWrite: 0,
				totalTokens: promptTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function createDoneStream(api: Api, promptTokens = 0) {
		const stream = createAssistantMessageEventStream();
		stream.end(createDoneMessage(api, promptTokens));
		return stream;
	}

	async function captureStreamOptions(
		api: Api,
		settings: Partial<Settings>,
		requestOptions: SimpleStreamOptions = {},
	): Promise<SimpleStreamOptions | undefined> {
		const model = createModel(api);
		const settingsManager = SettingsManager.inMemory(settings);
		const resourceLoader = new DefaultResourceLoader({
			extensionModules: extensionHostModules,
			themeAdapter: resourceThemeAdapter,
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [],
		});
		await resourceLoader.reload();

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRuntime = await createTestModelRuntime(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		const provider: Provider = {
			id: model.provider,
			name: "Capture provider",
			baseUrl: model.baseUrl,
			headers: { "x-provider": "provider" },
			auth: {
				apiKey: {
					name: "Test API key",
					resolve: async ({ credential }) =>
						credential ? { auth: { apiKey: credential.key }, source: "test credential" } : undefined,
				},
			},
			getModels: () => [model],
			stream: () => createDoneStream(api),
			streamSimple: (_requestModel, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream(api);
			},
		};
		modelRuntime.registerNativeProvider(provider);

		const sessionManager = SessionHistory.inMemory(cwd);
		const { session } = await assembleAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		try {
			const stream = await getTestAgent(session.execution).streamFunction(
				model,
				normalizeContext({ messages: [] }),
				requestOptions,
			);
			await stream.result();
			return capturedOptions;
		} finally {
			await session.execution.dispose();
			modelRuntime.unregisterProvider(model.provider);
		}
	}

	async function createCacheWarmingSession(populate?: (manager: SessionHistory, model: Model<Api>) => void) {
		const model: Model<Api> = {
			...createModel("anthropic-messages"),
			cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
			promptCache: { short: 300 },
		};
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRuntime = await createTestModelRuntime(authStorage, join(agentDir, "models.json"));
		let providerCalls = 0;
		modelRuntime.registerNativeProvider({
			id: model.provider,
			name: "Cache warming provider",
			auth: {
				apiKey: {
					name: "Test API key",
					resolve: async ({ credential }) =>
						credential ? { auth: { apiKey: credential.key }, source: "test credential" } : undefined,
				},
			},
			getModels: () => [model],
			stream: () => createDoneStream(model.api),
			streamSimple: () => {
				providerCalls++;
				return createDoneStream(model.api, 100_000);
			},
		});
		const sessionManager = SessionHistory.inMemory(cwd);
		populate?.(sessionManager, model);
		const { session } = await assembleAgentSession({
			extensionModules: extensionHostModules,
			themeAdapter: resourceThemeAdapter,
			cwd,
			agentDir,
			model,
			modelRuntime: modelRuntime,
			settingsManager: SettingsManager.inMemory({ cacheWarming: "idle" }),
			sessionManager,
		});
		return {
			session,
			providerCalls: () => providerCalls,
			dispose: async () => {
				await session.execution.dispose();
				modelRuntime.unregisterProvider(model.provider);
			},
		};
	}

	it("schedules cache warming after a completed session request", async () => {
		const fixture = await createCacheWarmingSession();
		try {
			await fixture.session.execution.prompt("test");
			expect(fixture.session.execution.cacheWarmingStatus?.nextWarmAt).toBeGreaterThan(Date.now());
		} finally {
			fixture.dispose();
		}
	});

	it("waits for the next request instead of restoring cache warming", async () => {
		const fixture = await createCacheWarmingSession((manager, model) => {
			manager.appendModelChange(model.provider, model.id);
			manager.appendThinkingLevelChange("off");
			manager.appendMessage({ role: "user", content: "test", timestamp: Date.now() - 60_000 });
			const assistant = { ...createDoneMessage(model.api, 100_000), timestamp: Date.now() - 59_000 };
			manager.appendMessage(assistant);
			manager.appendUsage("cache_warm", model.provider, model.id, assistant.usage);
		});
		try {
			expect(fixture.providerCalls()).toBe(0);
			expect(fixture.session.execution.cacheWarmingStatus).toEqual({
				state: "inactive",
				reason: "waiting for first request",
			});
		} finally {
			fixture.dispose();
		}
	});

	it("forwards httpIdleTimeoutMs as timeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("defaults timeoutMs from httpIdleTimeoutMs for all providers", async () => {
		const options = await captureStreamOptions("openai-completions", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("lets request timeoutMs override httpIdleTimeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ httpIdleTimeoutMs: 1234 },
			{ timeoutMs: 0 },
		);

		expect(options?.timeoutMs).toBe(0);
	});

	it("forwards websocketConnectTimeoutMs from settings", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { websocketConnectTimeoutMs: 1234 });

		expect(options?.websocketConnectTimeoutMs).toBe(1234);
	});

	it("lets request websocketConnectTimeoutMs override settings", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ websocketConnectTimeoutMs: 1234 },
			{ websocketConnectTimeoutMs: 0 },
		);

		expect(options?.websocketConnectTimeoutMs).toBe(0);
	});

	it("forwards provider retry settings", async () => {
		const options = await captureStreamOptions("openai-completions", {
			retry: { provider: { maxRetries: 2, maxRetryDelayMs: 3000 } },
		});

		expect(options?.maxRetries).toBe(2);
		expect(options?.maxRetryDelayMs).toBe(3000);
	});
});
