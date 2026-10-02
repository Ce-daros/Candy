import { describe, expect, it, vi } from "vitest";
import { builtinRuntime } from "./builtin-runtime.ts";

const streamSimple = builtinRuntime.streamSimple.bind(builtinRuntime);

import { findEnvKeys } from "../src/env-api-keys.ts";
import { getBuiltinModels as getModels } from "../src/providers/all.ts";

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

const INDIVIDUAL_TEXT_MODELS = [
	"deepseek-v4-flash-0731",
	"deepseek-v4-pro",
	"deepseek-v4-pro-0813",
	"glm-5.2",
	"qwen3.6-flash",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-flash",
	"qwen3.8-max",
];

const QWEN_THINKING_MODELS = [
	"deepseek-v3.2",
	"deepseek-v4-flash",
	"deepseek-v4-pro",
	"glm-5",
	"glm-5.1",
	"glm-5.2",
	"kimi-k2.5",
	"kimi-k2.6",
	"kimi-k2.7-code",
	"qwen3.6-flash",
	"qwen3.6-plus",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-flash",
	"qwen3.8-max",
] as const;

type QwenTokenPlanProvider = "qwen-token-plan" | "qwen-token-plan-cn" | "qwen-token-plan-individual";
type QwenTokenPlanModelCase = { provider: QwenTokenPlanProvider; modelId: string };

const QWEN_THINKING_MODEL_CASES: QwenTokenPlanModelCase[] = [
	...(["qwen-token-plan", "qwen-token-plan-cn"] as const).flatMap((provider) =>
		QWEN_THINKING_MODELS.map((modelId) => ({ provider, modelId })),
	),
	...INDIVIDUAL_TEXT_MODELS.map((modelId) => ({ provider: "qwen-token-plan-individual" as const, modelId })),
];

const QWEN_REASONING_EFFORT_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5", "glm-5.1", "glm-5.2"] as const;
const QWEN38_MODELS = ["qwen3.8-flash", "qwen3.8-max"] as const;

const QWEN_REASONING_EFFORT_MODEL_CASES: QwenTokenPlanModelCase[] = [
	...(["qwen-token-plan", "qwen-token-plan-cn"] as const).flatMap((provider) =>
		QWEN_REASONING_EFFORT_MODELS.map((modelId) => ({ provider, modelId })),
	),
	...["deepseek-v4-flash-0731", "deepseek-v4-pro", "deepseek-v4-pro-0813", "glm-5.2"].map((modelId) => ({
		provider: "qwen-token-plan-individual" as const,
		modelId,
	})),
];

const QWEN38_MODEL_CASES: QwenTokenPlanModelCase[] = (
	["qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual"] as const
).flatMap((provider) => QWEN38_MODELS.map((modelId) => ({ provider, modelId })));

describe("Qwen Token Plan models", () => {
	it("reuses the international Token Plan environment variable", () => {
		expect(findEnvKeys("qwen-token-plan-individual", { QWEN_TOKEN_PLAN_API_KEY: "test" })).toEqual([
			"QWEN_TOKEN_PLAN_API_KEY",
		]);
	});

	// docs: https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=api&commonbuy=1#/api/?type=model&url=3016807
	it.each(QWEN_THINKING_MODEL_CASES)(
		"sends Qwen thinking fields for $provider/$modelId",
		async ({ provider, modelId }) => {
			const model = getModels(provider).find((candidate) => candidate.id === modelId);
			expect(model).toBeDefined();
			if (!model) throw new Error(`Missing model: ${provider}/${modelId}`);

			let payload: unknown;
			await streamSimple(
				model,
				{
					messages: [
						{
							role: "user",
							content: "Hi",
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: "test",
					reasoning: "high",
					onPayload: (params) => {
						payload = params;
					},
				},
			).result();

			expect(payload).toHaveProperty("enable_thinking", true);
			expect(payload).not.toHaveProperty("thinking");
		},
	);

	it.each(QWEN_REASONING_EFFORT_MODEL_CASES)(
		"sends Qwen reasoning_effort for $provider/$modelId",
		async ({ provider, modelId }) => {
			const model = getModels(provider).find((candidate) => candidate.id === modelId);
			expect(model).toBeDefined();
			if (!model) throw new Error(`Missing model: ${provider}/${modelId}`);

			let payload: unknown;
			await streamSimple(
				model,
				{
					messages: [
						{
							role: "user",
							content: "Hi",
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: "test",
					reasoning: "high",
					onPayload: (params) => {
						payload = params;
					},
				},
			).result();

			expect(payload).toHaveProperty("reasoning_effort", "high");
		},
	);

	it.each(QWEN38_MODEL_CASES)(
		"sends qwen3.8 xhigh reasoning_effort for $provider/$modelId",
		async ({ provider, modelId }) => {
			const model = getModels(provider).find((candidate) => candidate.id === modelId);
			expect(model).toBeDefined();
			if (!model) throw new Error(`Missing model: ${provider}/${modelId}`);

			let payload: unknown;
			await streamSimple(
				model,
				{
					messages: [
						{
							role: "user",
							content: "Hi",
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: "test",
					reasoning: "xhigh",
					onPayload: (params) => {
						payload = params;
					},
				},
			).result();

			expect(payload).toHaveProperty("enable_thinking", true);
			expect(payload).toHaveProperty("reasoning_effort", "xhigh");
			expect(payload).not.toHaveProperty("thinking");
		},
	);
});
