import {
	type Api,
	type AuthType,
	type CredentialStore,
	InMemoryCredentialStore,
	type Model,
	type Provider,
} from "@candy/ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function authOptions(runtime: ModelRuntime, type?: AuthType) {
	return runtime
		.getProviders()
		.flatMap((provider) => [
			...(!type || type === "oauth"
				? provider.auth.oauth
					? [{ type: "oauth" as const, provider, method: provider.auth.oauth }]
					: []
				: []),
			...(!type || type === "api_key"
				? provider.auth.apiKey
					? [{ type: "api_key" as const, provider, method: provider.auth.apiKey }]
					: []
				: []),
		]);
}

function testModel(id: string, provider: string, headers?: Record<string, string>): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
		headers,
	};
}

function testProvider(
	id: string,
	name: string,
	auth: Provider["auth"],
	models: Model<Api>[] = [],
	streamSimple: Provider["streamSimple"] = () => {
		throw new Error("unused provider stream");
	},
	headers?: Provider["headers"],
): Provider {
	return {
		id,
		name,
		auth,
		headers,
		getModels: () => models,
		stream: () => {
			throw new Error("unused provider stream");
		},
		streamSimple,
	};
}

describe("ModelRuntime auth options", () => {
	it("accepts a pi-ai CredentialStore", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "stored-key" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });

		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("stored-key");
	});

	it("scopes provider availability reads and records refresh failures", async () => {
		const base = new InMemoryCredentialStore();
		const reads: string[] = [];
		let failReads = false;
		const credentials: CredentialStore = {
			read: async (providerId) => {
				reads.push(providerId);
				if (failReads) throw new Error(`read failed for ${providerId}`);
				return base.read(providerId);
			},
			list: () => base.list(),
			modify: (providerId, fn) => base.modify(providerId, fn),
			delete: (providerId) => base.delete(providerId),
		};
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });

		reads.length = 0;
		await runtime.getAvailable("anthropic");
		expect(new Set(reads)).toEqual(new Set(["anthropic"]));

		failReads = true;
		await expect(runtime.getAvailable("anthropic")).rejects.toThrow("Credential store read failed for anthropic");
		expect(runtime.getError()).toContain("Availability refresh: Credential store read failed for anthropic");

		failReads = false;
		await runtime.getAvailable();
		expect(runtime.getError()).toBeUndefined();
	});

	it("projects provider-owned methods, names, and status", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const options = authOptions(runtime);

		expect(options).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "google-vertex", name: "Google Vertex AI" }),
					method: expect.objectContaining({ name: "Google Cloud credentials" }),
				}),
				expect.objectContaining({
					type: "oauth",
					provider: expect.objectContaining({ id: "anthropic", name: "Anthropic" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "cloudflare-workers-ai", name: "Cloudflare Workers AI" }),
				}),
			]),
		);
		expect(authOptions(runtime, "api_key").every((option) => option.type === "api_key")).toBe(true);
		expect(authOptions(runtime, "oauth").every((option) => option.type === "oauth")).toBe(true);
		expect(options.some((option) => option.provider.id === "openai-codex" && option.type === "api_key")).toBe(false);
	});

	it("attaches the provider's active auth status to every method option", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				anthropic: {
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 60_000,
				},
			}),
			modelsPath: null,
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "anthropic");
		expect(options).toHaveLength(2);
		expect(await runtime.checkAuth("anthropic")).toMatchObject({ type: "oauth" });
	});

	it("distinguishes subscription OAuth from generic OAuth sign-in", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				anthropic: {
					type: "oauth",
					access: "anthropic-access",
					refresh: "anthropic-refresh",
					expires: Date.now() + 60 * 60_000,
				},
				openrouter: {
					type: "oauth",
					access: "openrouter-key",
					refresh: "",
					expires: Number.MAX_SAFE_INTEGER,
				},
			}),
			modelsPath: null,
		});

		expect(runtime.isUsingOAuth("anthropic")).toBe(true);
		expect(runtime.isUsingSubscription("anthropic")).toBe(true);
		expect(runtime.isUsingOAuth("openrouter")).toBe(true);
		expect(runtime.isUsingSubscription("openrouter")).toBe(false);
	});

	it("uses a native provider's API key method", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerNativeProvider(
			testProvider("extension-api-key", "Extension API Key", {
				apiKey: {
					name: "API key",
					login: async () => ({ type: "api_key", key: "key" }),
					resolve: async () => ({ auth: { apiKey: "key" }, source: "test" }),
				},
			}),
		);

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-api-key");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "api_key",
			provider: { id: "extension-api-key", name: "Extension API Key" },
			method: { name: "API key" },
		});
		expect(options[0]?.method.login).toBeTypeOf("function");
	});

	it("resolves native provider auth from request-scoped environment overrides", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerNativeProvider(
			testProvider("request-env-provider", "Request environment", {
				apiKey: {
					name: "API key",
					resolve: async ({ ctx }) => {
						const apiKey = await ctx.env("REQUEST_SCOPED_API_KEY");
						const header = await ctx.env("REQUEST_SCOPED_HEADER");
						if (!apiKey || !header) throw new Error("Request-scoped credentials are missing");
						return { auth: { apiKey, headers: { "x-request-value": header } }, source: "request env" };
					},
				},
			}),
		);

		const auth = await runtime.getAuth("request-env-provider", {
			env: { REQUEST_SCOPED_API_KEY: "request-key", REQUEST_SCOPED_HEADER: "request-header" },
		});

		expect(auth?.auth).toEqual({ apiKey: "request-key", headers: { "x-request-value": "request-header" } });
	});

	it("lets an explicit Authorization header override authHeader case-insensitively", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		runtime.registerNativeProvider(
			testProvider(
				"auth-header-provider",
				"Auth header",
				{
					apiKey: {
						name: "API key",
						resolve: async () => ({ auth: { apiKey: "generated-key" }, source: "test" }),
					},
				},
				[testModel("auth-header-model", "auth-header-provider")],
				(_model, _context, options) => {
					capturedHeaders = options?.headers;
					throw new Error("captured");
				},
			),
		);
		const model = runtime.getModel("auth-header-provider", "auth-header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(model!, { messages: [] }, { headers: { authorization: "Explicit token" } });

		expect(capturedHeaders).toEqual({ authorization: "Explicit token" });
	});

	it("transforms fully assembled headers once without forwarding the transform", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		let transforms = 0;
		runtime.registerNativeProvider(
			testProvider(
				"header-provider",
				"Header provider",
				{
					apiKey: {
						name: "API key",
						resolve: async () => ({
							auth: {
								apiKey: "generated-key",
								headers: { Authorization: "Bearer generated-key", "x-provider": "provider" },
							},
							source: "test",
						}),
					},
				},
				[testModel("header-model", "header-provider")],
				(_model, _context, options) => {
					expect(options).not.toHaveProperty("transformHeaders");
					capturedHeaders = options?.headers;
					throw new Error("captured");
				},
			),
		);
		const model = runtime.getModel("header-provider", "header-model");
		expect(model).toBeDefined();

		const stream = runtime.streamSimple(
			model!,
			{ messages: [] },
			{
				headers: { "x-explicit": "explicit" },
				transformHeaders: async (headers) => {
					transforms++;
					expect(headers).toEqual({
						Authorization: "Bearer generated-key",
						"x-provider": "provider",
						"x-explicit": "explicit",
					});
					return { ...headers, "x-transformed": "yes" };
				},
			},
		);
		for await (const _event of stream) {
		}
		await stream.result();

		expect(transforms).toBe(1);
		expect(capturedHeaders).toEqual({
			Authorization: "Bearer generated-key",
			"x-provider": "provider",
			"x-explicit": "explicit",
			"x-transformed": "yes",
		});
	});

	it("forwards cancellation to extension OAuth refresh", async () => {
		const credentials = AuthStorage.inMemory({
			"extension-oauth": {
				type: "oauth",
				access: "expired",
				refresh: "refresh",
				expires: 0,
			},
		});
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		let refreshSignal: AbortSignal | undefined;
		runtime.registerNativeProvider(
			testProvider("extension-oauth", "Extension OAuth", {
				oauth: {
					name: "Extension subscription",
					login: async () => ({
						type: "oauth",
						access: "access",
						refresh: "refresh",
						expires: Date.now() + 60_000,
					}),
					refresh: async (credential, signal) => {
						refreshSignal = signal;
						return { ...credential, expires: Date.now() + 60_000 };
					},
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			}),
		);
		const controller = new AbortController();

		await runtime.getAuth("extension-oauth", { signal: controller.signal });
		expect(refreshSignal).toBeInstanceOf(AbortSignal);
		const reason = new Error("cancelled");
		controller.abort(reason);
		expect(refreshSignal?.aborted).toBe(true);
		expect(refreshSignal?.reason).toBe(reason);
	});

	it("does not fabricate an API key method for an extension OAuth-only provider", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerNativeProvider(
			testProvider("extension-oauth", "Extension OAuth", {
				oauth: {
					name: "Extension subscription",
					isSubscription: true,
					login: async () => ({
						type: "oauth",
						access: "access",
						refresh: "refresh",
						expires: Date.now() + 60_000,
					}),
					refresh: async (credentials) => credentials,
					toAuth: async (credentials) => ({ apiKey: credentials.access }),
				},
			}),
		);

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-oauth");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "oauth",
			provider: { id: "extension-oauth", name: "Extension OAuth" },
			method: { name: "Extension subscription", isSubscription: true },
		});
	});
});
