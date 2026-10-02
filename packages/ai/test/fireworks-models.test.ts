import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { builtinRuntime } from "./builtin-runtime.ts";

const streamSimple = builtinRuntime.streamSimple.bind(builtinRuntime);

import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { getSupportedThinkingLevels, hasApi } from "../src/models.ts";
import { getBuiltinModels } from "../src/providers/all.ts";
import type { Api, Context, Model, ThinkingLevel, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const originalFireworksApiKey = process.env.FIREWORKS_API_KEY;

afterEach(() => {
	if (originalFireworksApiKey === undefined) {
		delete process.env.FIREWORKS_API_KEY;
	} else {
		process.env.FIREWORKS_API_KEY = originalFireworksApiKey;
	}
});

/** Fireworks chat models, grouped by API. The generated catalog refreshes on
 * every models.dev run, so tests assert provider invariants over the whole
 * catalog instead of pinning individual model ids. */
function fireworksMessagesModels(): Model<"anthropic-messages">[] {
	return getBuiltinModels("fireworks").filter((model) => hasApi(model, "anthropic-messages"));
}

function fireworksCompletionsModels(): Model<"openai-completions">[] {
	return getBuiltinModels("fireworks").filter((model) => hasApi(model, "openai-completions"));
}

async function capturePayload(
	model: Model<Api>,
	options: { reasoning?: ThinkingLevel },
): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	await streamSimple(
		model,
		{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
		{
			apiKey: "test-fireworks-key",
			reasoning: options.reasoning,
			onPayload: (value) => {
				payload = value as Record<string, unknown>;
				throw new Error("payload captured");
			},
		},
	).result();
	if (!payload) throw new Error("Expected payload capture before request");
	return payload;
}

describe("Fireworks models", () => {
	it("aligns -fast router models with their base model's OpenAI-compatible config", () => {
		const models = fireworksCompletionsModels();
		const fastRouters = models.filter((model) => model.id.endsWith("-fast"));
		expect(fastRouters.length).toBeGreaterThan(0);

		for (const fast of fastRouters) {
			// Bases live under /models/, so map router paths before stripping the suffix.
			const suffixless = fast.id.slice(0, -"-fast".length).replace("/routers/", "/models/");
			const base = models.find((model) => model.id === suffixless);
			expect(base, `${fast.id} has no base model`).toBeDefined();
			if (!base) continue;
			expect(fast.api).toBe(base.api);
			expect(fast.baseUrl).toBe(base.baseUrl);
			expect(fast.compat).toEqual(base.compat);
			expect(fast.thinkingLevelMap).toEqual(base.thinkingLevelMap);
		}
	});

	it("omits unsupported long cache retention for OpenAI-compatible Fireworks models", async () => {
		const models = fireworksCompletionsModels();
		expect(models.length).toBeGreaterThan(0);

		for (const model of models) {
			expect(model.compat?.supportsLongCacheRetention).toBe(false);
			const payload = await capturePayload(model, { reasoning: "high" });
			expect(payload.prompt_cache_retention, model.id).toBeUndefined();
		}
	});

	it("routes OpenAI-thinking-format Fireworks models through the OpenAI-compatible API with native effort controls", async () => {
		const models = fireworksCompletionsModels().filter((model) => model.compat?.thinkingFormat === "openai");
		expect(models.length).toBeGreaterThan(0);

		for (const model of models) {
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe("https://api.fireworks.ai/inference/v1");
			expect(model.compat).toEqual({
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsStrictMode: true,
				requiresReasoningContentOnAssistantMessages: true,
				thinkingFormat: "openai",
				supportsMidConvoSystemMessages: true,
				supportsMidConvoToolAdditions: true,
				sendSessionAffinityHeaders: true,
				supportsLongCacheRetention: false,
			});

			for (const level of getSupportedThinkingLevels(model)) {
				if (level === "off") continue;
				const payload = await capturePayload(model, { reasoning: level });
				expect(payload.reasoning_effort, `${model.id} at ${level}`).toBe(level);
			}
		}
	});

	// Regression for #9323: native effort must reach Messages without budget-based fallback.
	it("sends native Messages effort levels for adaptive-thinking Fireworks models", async () => {
		const models = fireworksMessagesModels().filter((model) => model.compat?.forceAdaptiveThinking === true);
		expect(models.length).toBeGreaterThan(0);

		for (const model of models) {
			const levels = getSupportedThinkingLevels(model);
			expect(levels.length, model.id).toBeGreaterThan(1);
			// Native effort levels map to themselves; aliases (e.g. medium -> high)
			// must not appear as distinct levels.
			for (const level of levels) {
				if (level === "off") continue;
				expect(model.thinkingLevelMap?.[level], `${model.id} at ${level}`).toBe(level);
			}

			for (const level of levels) {
				const payload = await capturePayload(model, { reasoning: level === "off" ? undefined : level });
				expect(payload.thinking, `${model.id} at ${level}`).toEqual(
					level === "off" ? { type: "disabled" } : { type: "adaptive", display: "summarized" },
				);
				expect(payload.output_config, `${model.id} at ${level}`).toEqual(
					level === "off" ? undefined : { effort: level },
				);
			}
		}
	});

	it("keeps toggle-only Messages models without a verified fallback on budget-based thinking", async () => {
		const models = fireworksMessagesModels().filter(
			(model) => model.reasoning && !model.compat?.forceAdaptiveThinking && !model.thinkingLevelMap,
		);
		expect(models.length).toBeGreaterThan(0);

		for (const model of models) {
			const payload = await capturePayload(model, { reasoning: "high" });
			expect(payload.thinking, model.id).toEqual({ type: "enabled", budget_tokens: 16384, display: "summarized" });
			expect(payload.output_config, model.id).toBeUndefined();
		}
	});

	it("resolves FIREWORKS_API_KEY from the environment", () => {
		process.env.FIREWORKS_API_KEY = "test-fireworks-key";

		expect(findEnvKeys("fireworks")).toEqual(["FIREWORKS_API_KEY"]);
		expect(getEnvApiKey("fireworks")).toBe("test-fireworks-key");
	});
});

// --- Integration tests for Fireworks Anthropic session affinity and tool compat ---

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

const tool: Tool = {
	name: "lookup",
	description: "Look up a value",
	parameters: Type.Object({ value: Type.String() }),
};

const FIREWORKS_ANTHROPIC_COMPAT = {
	allowEmptySignature: true,
	sendSessionAffinityHeaders: true,
	supportsEagerToolInputStreaming: false,
	supportsCacheControlOnTools: false,
	supportsLongCacheRetention: false,
} satisfies NonNullable<Model<"anthropic-messages">["compat"]>;

function createFireworksModel(
	compat: Model<"anthropic-messages">["compat"] = FIREWORKS_ANTHROPIC_COMPAT,
): Model<"anthropic-messages"> {
	return {
		id: "accounts/fireworks/models/kimi-k2p6",
		name: "Kimi K2.6",
		api: "anthropic-messages",
		provider: "fireworks",
		baseUrl: "http://127.0.0.1:0", // overridden by captureAnthropicRequest
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
		contextWindow: 262000,
		maxTokens: 262000,
		compat,
	};
}

function createAnthropicModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "http://127.0.0.1:0", // overridden by captureAnthropicRequest
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

function createOpenRouterModel(): Model<"anthropic-messages"> {
	return {
		...createAnthropicModel(),
		id: "anthropic/claude-opus-4.8",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api",
	};
}

function createContext(tools: Tool[] = [tool]): Context {
	return {
		messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
		...(tools.length > 0 ? { tools } : {}),
	};
}

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeEmptySseResponse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end();
}

async function captureAnthropicRequest(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: { sessionId?: string; cacheRetention?: string },
): Promise<CapturedRequest> {
	let capturedRequest: CapturedRequest | undefined;

	const server = createServer(async (request, response) => {
		capturedRequest = {
			headers: request.headers,
			body: await readRequestBody(request),
		};
		writeEmptySseResponse(response);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	try {
		// Override the model's baseUrl to point to the local test server
		const localModel = { ...model, baseUrl: `http://127.0.0.1:${address.port}` };

		const stream = streamAnthropic(localModel, normalizeContext(context), {
			apiKey: "test-key",
			cacheRetention: (options?.cacheRetention as "none" | "short" | "long") ?? "short",
			sessionId: options?.sessionId,
		});

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	if (!capturedRequest) {
		throw new Error("Anthropic request was not captured");
	}
	return capturedRequest;
}

function getTools(body: Record<string, unknown>): Record<string, unknown>[] {
	const tools = body.tools;
	if (!Array.isArray(tools)) {
		throw new Error("Expected tools in request body");
	}
	return tools as Record<string, unknown>[];
}

describe("Anthropic-compatible session affinity and tool compat", () => {
	it("sends x-session-affinity header for Fireworks models", async () => {
		const model = createFireworksModel();
		// Need a real port, capture will assign one
		const request = await captureAnthropicRequest(model, createContext(), {
			sessionId: "fireworks-session-1",
		});

		expect(request.headers["x-session-affinity"]).toBe("fireworks-session-1");
	});

	it("omits x-session-affinity header for native Anthropic models", async () => {
		const model = createAnthropicModel();
		const request = await captureAnthropicRequest(model, createContext(), {
			sessionId: "anthropic-session-1",
		});

		expect(request.headers["x-session-affinity"]).toBeUndefined();
	});

	it("omits x-session-affinity header when cacheRetention is none", async () => {
		const model = createFireworksModel();
		const request = await captureAnthropicRequest(model, createContext(), {
			sessionId: "fireworks-session-2",
			cacheRetention: "none",
		});

		expect(request.headers["x-session-affinity"]).toBeUndefined();
	});

	// Regression test for https://github.com/earendil-works/pi/issues/9102
	it("sends only x-session-id for OpenRouter models", async () => {
		const request = await captureAnthropicRequest(createOpenRouterModel(), createContext(), {
			sessionId: "openrouter-session-1",
		});

		expect(request.headers["x-session-id"]).toBe("openrouter-session-1");
		expect(request.headers["x-session-affinity"]).toBeUndefined();
	});

	it("omits OpenRouter session headers when cacheRetention is none", async () => {
		const request = await captureAnthropicRequest(createOpenRouterModel(), createContext(), {
			sessionId: "openrouter-session-2",
			cacheRetention: "none",
		});

		expect(request.headers["x-session-id"]).toBeUndefined();
		expect(request.headers["x-session-affinity"]).toBeUndefined();
	});

	it("allows OpenRouter session headers to be disabled", async () => {
		const model = { ...createOpenRouterModel(), compat: { sendSessionAffinityHeaders: false } };
		const request = await captureAnthropicRequest(model, createContext(), {
			sessionId: "openrouter-session-3",
		});

		expect(request.headers["x-session-id"]).toBeUndefined();
	});

	it("omits cache_control on tools for Fireworks models", async () => {
		const model = createFireworksModel();
		const request = await captureAnthropicRequest(model, createContext());

		const tools = getTools(request.body);
		const lastTool = tools[tools.length - 1];
		expect(lastTool.cache_control).toBeUndefined();
	});

	it("omits eager_input_streaming on tools for Fireworks models", async () => {
		const model = createFireworksModel();
		const request = await captureAnthropicRequest(model, createContext());

		const tools = getTools(request.body);
		for (const t of tools) {
			expect(t.eager_input_streaming).toBeUndefined();
		}
	});

	it("sends cache_control on tools for native Anthropic models", async () => {
		const model = createAnthropicModel();
		const request = await captureAnthropicRequest(model, createContext());

		const tools = getTools(request.body);
		const lastTool = tools[tools.length - 1];
		expect(lastTool.cache_control).toBeDefined();
		expect((lastTool.cache_control as { type: string }).type).toBe("ephemeral");
	});

	it("sends eager_input_streaming on tools for native Anthropic models", async () => {
		const model = createAnthropicModel();
		const request = await captureAnthropicRequest(model, createContext());

		const tools = getTools(request.body);
		expect(tools[0].eager_input_streaming).toBe(true);
	});
});
