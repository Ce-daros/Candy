import type { Model, Provider } from "@candy/ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

const dynamicModel: Model<"openai-completions"> = {
	id: "dynamic",
	name: "Dynamic",
	api: "openai-completions",
	provider: "stalled-login",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

describe("provider login while catalog refresh is pending", () => {
	it("does not hold login behind an older stalled network catalog refresh", async () => {
		let markNetworkStarted: (() => void) | undefined;
		const networkStarted = new Promise<void>((resolve) => {
			markNetworkStarted = resolve;
		});
		const provider: Provider<"openai-completions"> = {
			id: "stalled-login",
			name: "Stalled Login",
			auth: {
				apiKey: {
					name: "API key",
					login: async () => ({ type: "api_key", key: "secret" }),
					check: async ({ credential }) =>
						credential?.key ? { type: "api_key", source: "stored key" } : undefined,
					resolve: async ({ credential }) => ({
						auth: { apiKey: credential?.key ?? "ambient-key" },
						source: credential?.key ? "stored key" : "ambient key",
					}),
				},
			},
			getModels: () => [dynamicModel],
			refreshModels: async ({ allowNetwork }) => {
				if (!allowNetwork) return;
				markNetworkStarted?.();
				await new Promise<void>(() => {});
			},
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		runtime.registerNativeProvider(provider);
		await runtime.refresh({ allowNetwork: false, providers: [provider.id] });

		const stalledRefresh = runtime.refresh({ allowNetwork: true, providers: [provider.id] });
		await networkStarted;
		await expect(
			runtime.login(provider.id, "api_key", { prompt: async () => "unused", notify: () => {} }),
		).resolves.toEqual({ type: "api_key", key: "secret" });

		expect(runtime.getAvailableSnapshot().map((model) => model.id)).toContain(dynamicModel.id);
		expect(await credentials.read(provider.id)).toEqual({ type: "api_key", key: "secret" });
		await expect(stalledRefresh).resolves.toMatchObject({ aborted: false });
	});
});
