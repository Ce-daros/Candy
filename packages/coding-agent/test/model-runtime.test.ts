import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnthropicMessagesCompat, OpenAICompletionsCompat } from "@candy/ai";
import { builtinProviders, getBuiltinModels as getModels } from "@candy/ai/providers/all";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ModelsJsonProvider } from "../src/core/model-config.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { createTestModelRuntime } from "./model-runtime-test-utils.ts";

describe("ModelRuntime", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-model-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.inMemory();
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
	});

	/** Create a models.json provider entry. */
	function providerConfig(
		baseUrl: string,
		models: Array<{ id: string; name?: string }>,
		api: string = "anthropic-messages",
	): ModelsJsonProvider {
		return {
			baseUrl,
			apiKey: "test-key",
			api,
			models: models.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 8000,
			})),
		};
	}

	function writeModelsJson(providers: Record<string, ReturnType<typeof providerConfig>>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function getModelsForProvider(runtime: ModelRuntime, provider: string) {
		return runtime.getModels().filter((m) => m.provider === provider);
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	/** Create a baseUrl-only override (no custom models) */
	function overrideConfig(baseUrl: string, headers?: Record<string, string>) {
		return { baseUrl, ...(headers && { headers }) };
	}

	/** Write raw providers config (for mixed override/replacement scenarios) */
	function writeRawModelsJson(providers: Record<string, unknown>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	describe("baseUrl override (no custom models)", () => {
		test("surfaces provider configuration errors without restoring built-in models", async () => {
			writeRawModelsJson({ anthropic: {} });
			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);

			expect(runtime.getProvider("anthropic")).toBeUndefined();
			expect(runtime.getError()).toContain('Provider "anthropic"');
			expect(runtime.getError()).toContain('must specify "baseUrl"');
		});

		test("overriding baseUrl keeps all built-in models", async () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(runtime, "anthropic");

			// Should have multiple built-in models, not just one
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("overriding baseUrl changes URL on all built-in models", async () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(runtime, "anthropic");

			// All models should have the new baseUrl
			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://my-proxy.example.com/v1");
			}
		});

		test("overriding headers resolves at request time", async () => {
			await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1", {
					"X-Custom-Header": "custom-value",
				}),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(runtime, "anthropic");

			for (const model of anthropicModels) {
				expect((await runtime.getAuth(model))?.auth.headers?.["X-Custom-Header"]).toBe("custom-value");
			}
		});

		test("headers-only override resolves at request time", async () => {
			await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
			writeRawModelsJson({
				anthropic: {
					headers: {
						"X-Custom-Header": "custom-value",
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			expect(runtime.getError()).toBeUndefined();
			const anthropicModels = getModelsForProvider(runtime, "anthropic");

			for (const model of anthropicModels) {
				expect((await runtime.getAuth(model))?.auth.headers?.["X-Custom-Header"]).toBe("custom-value");
			}
		});

		test("baseUrl-only override does not affect other providers", async () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const googleModels = getModelsForProvider(runtime, "google");

			// Google models should still have their original baseUrl
			expect(googleModels.length).toBeGreaterThan(0);
			expect(googleModels[0].baseUrl).not.toBe("https://my-proxy.example.com/v1");
		});

		test("can mix baseUrl override and models merge", async () => {
			writeRawModelsJson({
				// baseUrl-only for anthropic
				anthropic: overrideConfig("https://anthropic-proxy.example.com/v1"),
				// Add custom model for google (merged with built-ins)
				google: providerConfig(
					"https://google-proxy.example.com/v1",
					[{ id: "gemini-custom" }],
					"google-generative-ai",
				),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);

			// Anthropic: multiple built-in models with new baseUrl
			const anthropicModels = getModelsForProvider(runtime, "anthropic");
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels[0].baseUrl).toBe("https://anthropic-proxy.example.com/v1");

			// Google: built-ins plus custom model
			const googleModels = getModelsForProvider(runtime, "google");
			expect(googleModels.length).toBeGreaterThan(1);
			expect(googleModels.some((m) => m.id === "gemini-custom")).toBe(true);
		});

		test("refresh() picks up baseUrl override changes", async () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://first-proxy.example.com/v1"),
			});
			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);

			expect(getModelsForProvider(runtime, "anthropic")[0].baseUrl).toBe("https://first-proxy.example.com/v1");

			// Update and refresh
			writeRawModelsJson({
				anthropic: overrideConfig("https://second-proxy.example.com/v1"),
			});
			await runtime.refresh();

			expect(getModelsForProvider(runtime, "anthropic")[0].baseUrl).toBe("https://second-proxy.example.com/v1");
		});
	});

	describe("custom models merge behavior", () => {
		test("built-in provider custom models inherit api and baseUrl without explicit fields", async () => {
			// Built-in providers already have api/baseUrl on every model, and auth
			// comes from env vars / auth storage. No need to specify them.
			writeRawModelsJson({
				openrouter: {
					models: [
						{
							id: "fake-provider/fake-model",
							name: "Fake model",
							reasoning: true,
							input: ["text"],
						},
					],
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			expect(runtime.getError()).toBeUndefined();

			const model = runtime.getModel("openrouter", "fake-provider/fake-model");
			expect(model).toBeDefined();
			expect(model?.api).toBe("openai-completions");
			expect(model?.baseUrl).toBe("https://openrouter.ai/api/v1");
		});

		test("custom models can use the pi-messages API", async () => {
			writeModelsJson({
				"custom-messages": providerConfig("http://localhost:8788/v1", [{ id: "custom-model" }], "pi-messages"),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const model = runtime.getModel("custom-messages", "custom-model");

			expect(runtime.getError()).toBeUndefined();
			expect(model).toMatchObject({
				api: "pi-messages",
				provider: "custom-messages",
				baseUrl: "http://localhost:8788/v1",
			});
		});

		test("non-built-in provider custom models still require baseUrl", async () => {
			writeRawModelsJson({
				"my-custom-provider": {
					apiKey: "test-key",
					models: [
						{
							id: "my-model",
							api: "openai-completions",
							reasoning: false,
							input: ["text"],
						},
					],
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			expect(runtime.getError()).toContain("baseUrl");
		});

		test("reports every provider composition error", async () => {
			writeRawModelsJson({
				"broken-one": { api: "openai-completions", models: [{ id: "one" }] },
				"broken-two": { api: "openai-completions", models: [{ id: "two" }] },
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const error = runtime.getError();

			expect(error).toContain('Provider "broken-one"');
			expect(error).toContain('Provider "broken-two"');
		});

		test("custom provider with same name as built-in merges with built-in models", async () => {
			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(runtime, "anthropic");

			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some((m) => m.id === "claude-custom")).toBe(true);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("custom model with same id replaces built-in model by id", async () => {
			writeModelsJson({
				openrouter: providerConfig(
					"https://my-proxy.example.com/v1",
					[{ id: "anthropic/claude-sonnet-4" }],
					"openai-completions",
				),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const models = getModelsForProvider(runtime, "openrouter");
			const sonnetModels = models.filter((m) => m.id === "anthropic/claude-sonnet-4");

			expect(sonnetModels).toHaveLength(1);
			expect(sonnetModels[0].baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom provider with same name as built-in does not affect other built-in providers", async () => {
			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);

			expect(getModelsForProvider(runtime, "google").length).toBeGreaterThan(0);
			expect(getModelsForProvider(runtime, "openai").length).toBeGreaterThan(0);
		});

		test("provider-level baseUrl applies to both built-in and custom models", async () => {
			writeModelsJson({
				anthropic: providerConfig("https://merged-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(runtime, "anthropic");

			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://merged-proxy.example.com/v1");
			}
		});

		test("provider-level compat applies to custom models", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const compat = runtime.getModel("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.supportsUsageInStreaming).toBe(false);
			expect(compat?.maxTokensField).toBe("max_tokens");
		});

		test("model-level compat overrides provider-level compat for custom models", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								supportsUsageInStreaming: true,
								maxTokensField: "max_completion_tokens",
							},
						},
					],
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const compat = runtime.getModel("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.supportsUsageInStreaming).toBe(true);
			expect(compat?.maxTokensField).toBe("max_completion_tokens");
		});

		test("provider-level compat applies to built-in models", async () => {
			writeRawModelsJson({
				openrouter: {
					compat: {
						supportsUsageInStreaming: false,
						supportsStrictMode: false,
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const models = getModelsForProvider(runtime, "openrouter");

			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				const compat = model.compat as OpenAICompletionsCompat | undefined;
				expect(compat?.supportsUsageInStreaming).toBe(false);
				expect(compat?.supportsStrictMode).toBe(false);
			}
		});

		test("model schema accepts thinkingLevelMap and compat schema accepts supportsStrictMode and cacheControlFormat", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					models: [
						{
							id: "demo-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							thinkingLevelMap: {
								minimal: null,
								high: "max",
							},
							compat: {
								supportsStrictMode: false,
								cacheControlFormat: "anthropic",
							},
						},
					],
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const model = runtime.getModel("demo", "demo-model");
			const compat = model?.compat as OpenAICompletionsCompat | undefined;

			expect(runtime.getError()).toBeUndefined();
			expect(model?.thinkingLevelMap).toEqual({ minimal: null, high: "max" });
			expect(compat?.supportsStrictMode).toBe(false);
			expect(compat?.cacheControlFormat).toBe("anthropic");
		});

		test("compat schema accepts chat template thinking configuration", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					models: [
						{
							id: "kwargs-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								thinkingFormat: "chat-template",
								chatTemplateKwargs: {
									preserve_thinking: true,
									thinking: { $var: "thinking.enabled" },
								},
							},
						},
					],
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const kwargsCompat = runtime.getModel("demo", "kwargs-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(runtime.getError()).toBeUndefined();
			expect(kwargsCompat?.thinkingFormat).toBe("chat-template");
			expect(kwargsCompat?.chatTemplateKwargs).toEqual({
				preserve_thinking: true,
				thinking: { $var: "thinking.enabled" },
			});
		});

		test("compat schema accepts Anthropic eager tool input streaming flag", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com",
					apiKey: "DEMO_KEY",
					api: "anthropic-messages",
					compat: {
						supportsEagerToolInputStreaming: false,
					},
					models: [
						{
							id: "demo-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const compat = runtime.getModel("demo", "demo-model")?.compat as AnthropicMessagesCompat | undefined;

			expect(runtime.getError()).toBeUndefined();
			expect(compat?.supportsEagerToolInputStreaming).toBe(false);
		});

		test("compat schema accepts long cache retention flag", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com",
					apiKey: "DEMO_KEY",
					api: "anthropic-messages",
					compat: {
						supportsLongCacheRetention: false,
					},
					models: [
						{
							id: "demo-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const compat = runtime.getModel("demo", "demo-model")?.compat as AnthropicMessagesCompat | undefined;

			expect(runtime.getError()).toBeUndefined();
			expect(compat?.supportsLongCacheRetention).toBe(false);
		});

		test("model-level baseUrl overrides provider-level baseUrl for custom models", async () => {
			writeRawModelsJson({
				"opencode-go": {
					baseUrl: "https://opencode.ai/zen/go/v1",
					apiKey: "TEST_KEY",
					models: [
						{
							id: "minimax-m2.5",
							api: "anthropic-messages",
							baseUrl: "https://opencode.ai/zen/go",
							reasoning: true,
							input: ["text"],
							cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
						{
							id: "glm-5",
							api: "openai-completions",
							reasoning: true,
							input: ["text"],
							cost: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
					],
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const m25 = runtime.getModel("opencode-go", "minimax-m2.5");
			const glm5 = runtime.getModel("opencode-go", "glm-5");

			expect(m25?.baseUrl).toBe("https://opencode.ai/zen/go");
			expect(glm5?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
		});

		test("modelOverrides still apply when provider also defines models", async () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "OPENROUTER_API_KEY",
					api: "openai-completions",
					models: [
						{
							id: "custom/openrouter-model",
							name: "Custom OpenRouter Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 16384,
						},
					],
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Overridden Built-in Sonnet",
						},
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const models = getModelsForProvider(runtime, "openrouter");

			expect(models.some((m) => m.id === "custom/openrouter-model")).toBe(true);
			expect(
				models.some((m) => m.id === "anthropic/claude-sonnet-4" && m.name === "Overridden Built-in Sonnet"),
			).toBe(true);
		});

		test("refresh() reloads merged custom models from disk", async () => {
			writeModelsJson({
				anthropic: providerConfig("https://first-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			expect(getModelsForProvider(runtime, "anthropic").some((m) => m.id === "claude-custom")).toBe(true);

			// Update and refresh
			writeModelsJson({
				anthropic: providerConfig("https://second-proxy.example.com/v1", [{ id: "claude-custom-2" }]),
			});
			await runtime.refresh();

			const anthropicModels = getModelsForProvider(runtime, "anthropic");
			expect(anthropicModels.some((m) => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some((m) => m.id === "claude-custom-2")).toBe(true);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("removing custom models from models.json keeps built-in provider models", async () => {
			writeModelsJson({
				anthropic: providerConfig("https://proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			expect(getModelsForProvider(runtime, "anthropic").some((m) => m.id === "claude-custom")).toBe(true);

			// Remove custom models and refresh
			writeModelsJson({});
			await runtime.refresh();

			const anthropicModels = getModelsForProvider(runtime, "anthropic");
			expect(anthropicModels.some((m) => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});
	});

	describe("modelOverrides (per-model customization)", () => {
		test("model override applies to a single built-in model", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Custom Sonnet Name",
						},
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const models = getModelsForProvider(runtime, "openrouter");

			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			expect(sonnet?.name).toBe("Custom Sonnet Name");

			// Other models should be unchanged
			const opus = models.find((m) => m.id === "anthropic/claude-opus-4.1");
			expect(opus?.name).not.toBe("Custom Sonnet Name");
		});

		test("Anthropic model override replaces allowed fallback metadata", async () => {
			const allowedFallbackModels = [
				{
					provider: "anthropic",
					model: "claude-opus-5",
					cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
				},
				{
					provider: "anthropic",
					model: "claude-opus-4-8",
					cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
				},
			];
			writeRawModelsJson({
				anthropic: {
					modelOverrides: {
						"claude-fable-5": {
							compat: { allowedFallbackModels },
						},
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const compat = runtime.getModel("anthropic", "claude-fable-5")?.compat as AnthropicMessagesCompat | undefined;

			expect(runtime.getError()).toBeUndefined();
			expect(compat?.allowedFallbackModels).toEqual(allowedFallbackModels);
		});

		test("empty allowed fallback model override disables server-side fallback", async () => {
			writeRawModelsJson({
				anthropic: {
					modelOverrides: {
						"claude-fable-5": { compat: { allowedFallbackModels: [] } },
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const compat = runtime.getModel("anthropic", "claude-fable-5")?.compat as AnthropicMessagesCompat | undefined;

			expect(runtime.getError()).toBeUndefined();
			expect(compat?.allowedFallbackModels).toEqual([]);
		});

		test("custom model and model override carry sampling params", async () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					api: "openai-completions",
					models: [
						{
							id: "custom/sampling-model",
							samplingParams: { temperature: 1, top_p: 0.95, top_k: 0 },
						},
					],
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							samplingParams: { top_p: 0.9 },
						},
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const models = getModelsForProvider(runtime, "openrouter");

			const custom = models.find((m) => m.id === "custom/sampling-model");
			expect(custom?.samplingParams).toEqual({ temperature: 1, top_p: 0.95, top_k: 0 });

			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			expect(sonnet?.samplingParams).toEqual({ top_p: 0.9 });

			// Models without sampling config keep it unset.
			const opus = models.find((m) => m.id === "anthropic/claude-opus-4.1");
			expect(opus?.samplingParams).toBeUndefined();
		});

		test("custom model and model override carry prompt cache lifetimes", async () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					api: "openai-completions",
					models: [{ id: "custom/cached-model", promptCache: { short: 120 } }],
					modelOverrides: {
						"anthropic/claude-sonnet-4": { promptCache: { short: 300 } },
					},
				},
				anthropic: {
					modelOverrides: {
						"claude-sonnet-4-6": { promptCache: { long: 1800 } },
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const openrouter = getModelsForProvider(runtime, "openrouter");

			expect(runtime.getError()).toBeUndefined();
			expect(openrouter.find((m) => m.id === "custom/cached-model")?.promptCache).toEqual({ short: 120 });
			expect(openrouter.find((m) => m.id === "anthropic/claude-sonnet-4")?.promptCache).toEqual({ short: 300 });
			expect(openrouter.find((m) => m.id === "anthropic/claude-opus-4.1")?.promptCache).toBeUndefined();
			// Overrides merge per tier with the built-in catalog.
			expect(runtime.getModel("anthropic", "claude-sonnet-4-6")?.promptCache).toEqual({ short: 300, long: 1800 });
		});

		// Regression test for https://github.com/earendil-works/pi/issues/9631
		test("model override deep-merges image resize limits", async () => {
			writeRawModelsJson({
				test: {
					baseUrl: "https://example.com",
					apiKey: "test-key",
					api: "openai-completions",
					models: [
						{
							id: "vision-model",
							input: ["text", "image"],
							inputLimits: {
								maxRequestBytes: 32 * 1024 * 1024,
								images: {
									maxPerRequest: 100,
									resize: {
										maxWidth: 2000,
										maxHeight: 2000,
										maxBytes: 4.5 * 1024 * 1024,
										jpegQuality: 80,
									},
								},
							},
						},
					],
					modelOverrides: {
						"vision-model": {
							inputLimits: {
								images: { resize: { maxWidth: 1568, maxBytes: 524288, jpegQuality: 75 } },
							},
						},
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const model = runtime.getModel("test", "vision-model");

			expect(runtime.getError()).toBeUndefined();
			expect(model?.inputLimits).toMatchObject({
				maxRequestBytes: 32 * 1024 * 1024,
				images: {
					maxPerRequest: 100,
					resize: { maxWidth: 1568, maxHeight: 2000, maxBytes: 524288, jpegQuality: 75 },
				},
			});
		});

		test("model override with compat.openRouterRouting", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								openRouterRouting: { only: ["amazon-bedrock"] },
							},
						},
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const models = getModelsForProvider(runtime, "openrouter");

			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			const compat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
		});

		test("supportsFinishReason can be configured at provider and model levels", async () => {
			const provider: ModelsJsonProvider = {
				compat: { supportsFinishReason: true },
				modelOverrides: {
					"anthropic/claude-sonnet-4": {
						compat: { supportsFinishReason: false },
					},
				},
			};
			writeRawModelsJson({ openrouter: provider });

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const models = getModelsForProvider(runtime, "openrouter");
			const sonnet = models.find((model) => model.id === "anthropic/claude-sonnet-4");
			const opus = models.find((model) => model.id === "anthropic/claude-opus-4.1");

			expect((sonnet?.compat as OpenAICompletionsCompat | undefined)?.supportsFinishReason).toBe(false);
			expect((opus?.compat as OpenAICompletionsCompat | undefined)?.supportsFinishReason).toBe(true);
		});

		test("model override deep merges compat settings", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								openRouterRouting: { order: ["anthropic", "together"] },
							},
						},
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const models = getModelsForProvider(runtime, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");

			// Should have both the new routing AND preserve other compat settings
			const compat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ order: ["anthropic", "together"] });
		});

		test("multiple model overrides on same provider", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: { openRouterRouting: { only: ["amazon-bedrock"] } },
						},
						"anthropic/claude-opus-4.1": {
							compat: { openRouterRouting: { only: ["anthropic"] } },
						},
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const models = getModelsForProvider(runtime, "openrouter");

			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			const opus = models.find((m) => m.id === "anthropic/claude-opus-4.1");

			const sonnetCompat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			const opusCompat = opus?.compat as OpenAICompletionsCompat | undefined;
			expect(sonnetCompat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
			expect(opusCompat?.openRouterRouting).toEqual({ only: ["anthropic"] });
		});

		test("model override combined with baseUrl override", async () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Proxied Sonnet",
						},
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const models = getModelsForProvider(runtime, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");

			// Both overrides should apply
			expect(sonnet?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(sonnet?.name).toBe("Proxied Sonnet");

			// Other models should have the baseUrl but not the name override
			const opus = models.find((m) => m.id === "anthropic/claude-opus-4.1");
			expect(opus?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(opus?.name).not.toBe("Proxied Sonnet");
		});

		test("model override for non-existent model ID is ignored", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"nonexistent/model-id": {
							name: "This should not appear",
						},
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const models = getModelsForProvider(runtime, "openrouter");

			// Should not create a new model
			expect(models.find((m) => m.id === "nonexistent/model-id")).toBeUndefined();
			// Should not crash or show error
			expect(runtime.getError()).toBeUndefined();
		});

		test("model override can change cost fields partially", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							cost: { input: 99 },
						},
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const models = getModelsForProvider(runtime, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");

			// Input cost should be overridden
			expect(sonnet?.cost.input).toBe(99);
			// Other cost fields should be preserved from built-in
			expect(sonnet?.cost.output).toBeGreaterThan(0);
		});

		test("model override can add headers at request time", async () => {
			await authStorage.modify("openrouter", async () => ({ type: "api_key", key: "test-key" }));
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							headers: { "X-Custom-Model-Header": "value" },
						},
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const models = getModelsForProvider(runtime, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			expect(sonnet).toBeDefined();

			const auth = await runtime.getAuth(sonnet!);
			expect(auth?.auth.headers?.["X-Custom-Model-Header"]).toBe("value");
		});

		test("refresh() picks up model override changes", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "First Name",
						},
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			expect(
				getModelsForProvider(runtime, "openrouter").find((m) => m.id === "anthropic/claude-sonnet-4")?.name,
			).toBe("First Name");

			// Update and refresh
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Second Name",
						},
					},
				},
			});
			await runtime.refresh();

			expect(
				getModelsForProvider(runtime, "openrouter").find((m) => m.id === "anthropic/claude-sonnet-4")?.name,
			).toBe("Second Name");
		});

		test("removing model override restores built-in values", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Custom Name",
						},
					},
				},
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const customName = getModelsForProvider(runtime, "openrouter").find(
				(m) => m.id === "anthropic/claude-sonnet-4",
			)?.name;
			expect(customName).toBe("Custom Name");

			// Remove override and refresh
			writeRawModelsJson({});
			await runtime.refresh();

			const restoredName = getModelsForProvider(runtime, "openrouter").find(
				(m) => m.id === "anthropic/claude-sonnet-4",
			)?.name;
			expect(restoredName).not.toBe("Custom Name");
		});
	});

	describe("provider metadata", () => {
		test("lists built-in providers only", async () => {
			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			expect(runtime.getProvider("openai")?.name).toBe("OpenAI");
			expect(runtime.getProvider("github-copilot")?.name).toBe("GitHub Copilot");
			expect(runtime.getProvider("zai")?.name).toBe("Z.AI");
			expect(runtime.getProvider("unknown-provider")).toBeUndefined();
		});
	});

	describe("API key resolution", () => {
		/** Create provider config with custom apiKey */
		function providerWithApiKey(apiKey: string) {
			return {
				baseUrl: "https://example.com/v1",
				apiKey,
				api: "anthropic-messages",
				models: [
					{
						id: "test-model",
						name: "Test Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 100000,
						maxTokens: 8000,
					},
				],
			};
		}

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo test-api-key-from-command"),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const auth = await runtime.getAuth("custom-provider");

			expect(auth?.auth.apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo '  spaced-key  '"),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const auth = await runtime.getAuth("custom-provider");

			expect(auth?.auth.apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!printf 'line1\\nline2'"),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const auth = await runtime.getAuth("custom-provider");

			expect(auth?.auth.apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix rejects when command fails", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!exit 1"),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			await expect(runtime.getAuth("custom-provider")).rejects.toThrow("API key auth failed");
		});

		test("apiKey with ! prefix rejects when command is missing", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!nonexistent-command-12345"),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			await expect(runtime.getAuth("custom-provider")).rejects.toThrow("API key auth failed");
		});

		test("apiKey with ! prefix rejects when command output is empty", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!printf ''"),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			await expect(runtime.getAuth("custom-provider")).rejects.toThrow("API key auth failed");
		});

		test("apiKey with $ prefix resolves to env value", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("$TEST_API_KEY_12345"),
				});

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
				const auth = await runtime.getAuth("custom-provider");

				expect(auth?.auth.apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey with braced env syntax resolves to env value", async () => {
			const originalEnv = process.env.TEST_BRACED_API_KEY_12345;
			process.env.TEST_BRACED_API_KEY_12345 = "braced-env-api-key-value";
			const bracedKey = "$" + "{TEST_BRACED_API_KEY_12345}";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(bracedKey),
				});

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
				const auth = await runtime.getAuth("custom-provider");

				expect(auth?.auth.apiKey).toBe("braced-env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_BRACED_API_KEY_12345;
				} else {
					process.env.TEST_BRACED_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey interpolates braced env references inside literals", async () => {
			const originalPartA = process.env.TEST_INTERPOLATED_PART_A_12345;
			const originalPartB = process.env.TEST_INTERPOLATED_PART_B_12345;
			process.env.TEST_INTERPOLATED_PART_A_12345 = "left";
			process.env.TEST_INTERPOLATED_PART_B_12345 = "right";
			const interpolatedKey = ["$", "{TEST_INTERPOLATED_PART_A_12345}_$", "{TEST_INTERPOLATED_PART_B_12345}"].join(
				"",
			);

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(interpolatedKey),
				});

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
				const auth = await runtime.getAuth("custom-provider");

				expect(auth?.auth.apiKey).toBe("left_right");
			} finally {
				if (originalPartA === undefined) {
					delete process.env.TEST_INTERPOLATED_PART_A_12345;
				} else {
					process.env.TEST_INTERPOLATED_PART_A_12345 = originalPartA;
				}
				if (originalPartB === undefined) {
					delete process.env.TEST_INTERPOLATED_PART_B_12345;
				} else {
					process.env.TEST_INTERPOLATED_PART_B_12345 = originalPartB;
				}
			}
		});

		test("apiKey with $$ prefix escapes a leading dollar", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("$$TEST_API_KEY_12345"),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const auth = await runtime.getAuth("custom-provider");

			expect(auth?.auth.apiKey).toBe("$TEST_API_KEY_12345");
		});

		test("apiKey with $! escapes a literal bang and still interpolates later env refs", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("$!literal-$TEST_API_KEY_12345"),
				});

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
				const auth = await runtime.getAuth("custom-provider");

				expect(auth?.auth.apiKey).toBe("!literal-env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("plain apiKey is used directly even when it matches an env var", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("TEST_API_KEY_12345"),
				});

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
				const auth = await runtime.getAuth("custom-provider");

				expect(auth?.auth.apiKey).toBe("TEST_API_KEY_12345");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			// Make sure this isn't an env var
			delete process.env.literal_api_key_value;

			writeRawModelsJson({
				"custom-provider": providerWithApiKey("literal_api_key_value"),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const auth = await runtime.getAuth("custom-provider");

			expect(auth?.auth.apiKey).toBe("literal_api_key_value");
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo 'hello world' | tr ' ' '-'"),
			});

			const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
			const auth = await runtime.getAuth("custom-provider");

			expect(auth?.auth.apiKey).toBe("hello-world");
		});

		describe("request-time resolution", () => {
			test("successful command output is cached for the runtime", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
				await runtime.getAuth("custom-provider");
				await runtime.getAuth("custom-provider");
				await runtime.getAuth("custom-provider");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("commands are re-executed across runtime instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const runtime1 = await createTestModelRuntime(authStorage, modelsJsonPath);
				await runtime1.getAuth("custom-provider");

				const runtime2 = await createTestModelRuntime(authStorage, modelsJsonPath);
				await runtime2.getAuth("custom-provider");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("different commands resolve independently", async () => {
				writeRawModelsJson({
					"provider-a": providerWithApiKey("!echo key-a"),
					"provider-b": providerWithApiKey("!echo key-b"),
				});

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);

				const authA = await runtime.getAuth("provider-a");
				const authB = await runtime.getAuth("provider-b");

				expect(authA?.auth.apiKey).toBe("key-a");
				expect(authB?.auth.apiKey).toBe("key-b");
			});

			test("failed commands are retried", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
				await expect(runtime.getAuth("custom-provider")).rejects.toThrow("API key auth failed");
				await expect(runtime.getAuth("custom-provider")).rejects.toThrow("API key auth failed");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("provider auth status reports apiKey environment variables from models.json", async () => {
				const envVarName = "TEST_API_KEY_STATUS_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "status-test-key";

					writeRawModelsJson({
						"custom-provider": providerWithApiKey(`$${envVarName}`),
					});

					const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);

					expect(runtime.getProviderAuthStatus("custom-provider")).toEqual({
						configured: true,
						source: "environment",
						label: envVarName,
					});
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});

			test("provider auth status reports interpolated apiKey environment variables", async () => {
				const envVarNameA = "TEST_API_KEY_STATUS_PART_A_98765";
				const envVarNameB = "TEST_API_KEY_STATUS_PART_B_98765";
				const originalEnvA = process.env[envVarNameA];
				const originalEnvB = process.env[envVarNameB];
				process.env[envVarNameA] = "left";
				process.env[envVarNameB] = "right";
				const interpolatedKey = ["$", "{", envVarNameA, "}_$", "{", envVarNameB, "}"].join("");

				try {
					writeRawModelsJson({
						"custom-provider": providerWithApiKey(interpolatedKey),
					});

					const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);

					expect(runtime.getProviderAuthStatus("custom-provider")).toEqual({
						configured: true,
						source: "environment",
						label: `${envVarNameA}, ${envVarNameB}`,
					});
				} finally {
					if (originalEnvA === undefined) {
						delete process.env[envVarNameA];
					} else {
						process.env[envVarNameA] = originalEnvA;
					}
					if (originalEnvB === undefined) {
						delete process.env[envVarNameB];
					} else {
						process.env[envVarNameB] = originalEnvB;
					}
				}
			});

			test("provider auth status reports non-env apiKey values from models.json as a config key", async () => {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("literal_api_key_value"),
				});

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);

				expect(runtime.getProviderAuthStatus("custom-provider")).toEqual({
					configured: true,
					source: "models_json_key",
				});
			});

			test("missing explicit env apiKey keeps provider unavailable", async () => {
				const envVarName = "TEST_API_KEY_MISSING_TEST_98765";
				const originalEnv = process.env[envVarName];
				delete process.env[envVarName];

				try {
					writeRawModelsJson({
						"custom-provider": providerWithApiKey(`$${envVarName}`),
					});

					const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);

					expect(runtime.getProviderAuthStatus("custom-provider")).toEqual({ configured: false });
					expect(runtime.getAvailableSnapshot().some((model) => model.provider === "custom-provider")).toBe(false);
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});

			test("provider auth status reports command apiKey values from models.json without executing them", async () => {
				const counterFile = join(tempDir, "status-counter");
				writeFileSync(counterFile, "0");
				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'echo 1 > "${counterPath}"; echo key-value'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);

				expect(runtime.getProviderAuthStatus("custom-provider")).toEqual({
					configured: true,
					source: "models_json_command",
				});
				expect(readFileSync(counterFile, "utf-8")).toBe("0");
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_API_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeRawModelsJson({
						"custom-provider": providerWithApiKey(`$${envVarName}`),
					});

					const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);

					const auth1 = await runtime.getAuth("custom-provider");
					expect(auth1?.auth.apiKey).toBe("first-value");

					process.env[envVarName] = "second-value";

					const auth2 = await runtime.getAuth("custom-provider");
					expect(auth2?.auth.apiKey).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});

			test("getAvailable does not execute command-backed apiKey resolution", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
				const available = runtime.getAvailableSnapshot();

				expect(available.some((m) => m.provider === "custom-provider")).toBe(true);
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(0);
			});

			test("getAvailable filters GitHub Copilot OAuth models to account picker availability", async () => {
				const copilotModel = getModels("github-copilot")[0];
				if (!copilotModel) throw new Error("Expected at least one GitHub Copilot model");

				await authStorage.modify("github-copilot", async () => ({
					type: "oauth",
					refresh: "github-access-token",
					access: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
					expires: Date.now() + 60_000,
					availableModelIds: [copilotModel.id],
				}));

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);

				expect(
					runtime
						.getAvailableSnapshot()
						.filter((m) => m.provider === "github-copilot")
						.map((m) => m.id),
				).toEqual([copilotModel.id]);
			});

			test("getAuth caches command-backed auth for the runtime", async () => {
				const tokenFile = join(tempDir, "token");
				writeFileSync(tokenFile, "token-1");
				const tokenPath = toShPath(tokenFile);

				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey(`!sh -c 'cat "${tokenPath}"'`),
						authHeader: true,
					},
				});

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
				const model = runtime.getModel("custom-provider", "test-model");
				expect(model).toBeDefined();

				const auth1 = await runtime.getAuth(model!);
				expect(auth1?.auth).toEqual({
					apiKey: "token-1",
					headers: { Authorization: "Bearer token-1" },
				});

				writeFileSync(tokenFile, "token-2");

				const auth2 = await runtime.getAuth(model!);
				expect(auth2?.auth).toEqual({
					apiKey: "token-1",
					headers: { Authorization: "Bearer token-1" },
				});
			});

			test("getAuth resolves configured auth exactly once", async () => {
				const counterFile = join(tempDir, "auth-counter");
				writeFileSync(counterFile, "0");
				const counterPath = toShPath(counterFile);
				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey(
							`!sh -c 'count=$(cat "${counterPath}"); count=$((count + 1)); echo "$count" > "${counterPath}"; echo "token-$count"'`,
						),
						authHeader: true,
					},
				});

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
				const auth = await runtime.getAuth(runtime.getModel("custom-provider", "test-model")!);

				expect(auth?.auth).toEqual({
					apiKey: "token-1",
					headers: { Authorization: "Bearer token-1" },
				});
				expect(readFileSync(counterFile, "utf-8").trim()).toBe("1");
			});

			test("stored credentials bypass lower-priority configured auth commands", async () => {
				const counterFile = join(tempDir, "fallback-counter");
				writeFileSync(counterFile, "0");
				const counterPath = toShPath(counterFile);
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(`!sh -c 'echo 1 > "${counterPath}"; echo fallback-key'`),
				});
				await authStorage.modify("custom-provider", async () => ({ type: "api_key", key: "stored-key" }));

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
				const auth = await runtime.getAuth(runtime.getModel("custom-provider", "test-model")!);

				expect(auth?.auth.apiKey).toBe("stored-key");
				expect(readFileSync(counterFile, "utf-8").trim()).toBe("0");
			});

			test("configured authHeader remains explicit when no credential exists", async () => {
				writeRawModelsJson({
					"custom-provider": {
						baseUrl: "https://example.test/v1",
						api: "openai-completions",
						authHeader: true,
						models: [{ id: "test-model" }],
					},
				});

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
				const model = runtime.getModel("custom-provider", "test-model");
				expect(model).toBeDefined();
				expect(await runtime.getAuth(model!)).toBeUndefined();
			});

			test("getAuth rejects failed command-backed credential resolution", async () => {
				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey("!exit 1"),
						authHeader: true,
					},
				});

				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
				const model = runtime.getModel("custom-provider", "test-model");
				expect(model).toBeDefined();

				await expect(runtime.getAuth(model!)).rejects.toThrow("Shell command failed (1): exit 1");
			});

			test("runtime disposal cancels and settles command-backed credential resolution", async () => {
				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey("!sleep 5"),
						authHeader: true,
					},
				});
				const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
				const model = runtime.getModel("custom-provider", "test-model");
				expect(model).toBeDefined();

				const resolution = runtime.getAuth(model!);
				await new Promise((resolve) => setTimeout(resolve, 30));
				await runtime.dispose();
				await expect(resolution).rejects.toMatchObject({ name: "AbortError" });
			});
		});
	});

	test("shares catalog refresh work while callers cancel independently", async () => {
		const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
		const provider = builtinProviders().find((candidate) => candidate.id === "anthropic");
		if (!provider) throw new Error("Anthropic provider is missing");
		let refreshCount = 0;
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let finishRefresh!: () => void;
		runtime.registerNativeProvider({
			...provider,
			refreshModels: async () => {
				refreshCount++;
				markStarted();
				await new Promise<void>((resolve) => {
					finishRefresh = resolve;
				});
			},
		});
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = runtime.refresh({ providers: ["anthropic"], signal: firstController.signal });
		await started;
		const second = runtime.refresh({ providers: ["anthropic"], signal: secondController.signal });
		firstController.abort();
		await expect(first).resolves.toMatchObject({ aborted: true });
		finishRefresh();
		await expect(second).resolves.toMatchObject({ aborted: false });
		expect(refreshCount).toBe(1);
	});

	test("disposal aborts and settles owned catalog refreshes", async () => {
		const runtime = await createTestModelRuntime(authStorage, modelsJsonPath);
		const provider = builtinProviders().find((candidate) => candidate.id === "anthropic");
		if (!provider) throw new Error("Anthropic provider is missing");
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		runtime.registerNativeProvider({
			...provider,
			refreshModels: async ({ signal }) => {
				markStarted();
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
		});
		const refresh = runtime.refresh({ providers: ["anthropic"] });
		await started;
		await runtime.dispose();
		await expect(refresh).resolves.toMatchObject({ aborted: true });
		expect(() => runtime.refresh()).toThrow("Model runtime is disposed");
	});
});
