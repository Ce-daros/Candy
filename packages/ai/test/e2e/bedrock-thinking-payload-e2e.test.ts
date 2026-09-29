import { describe, expect, it } from "vitest";
import { stream as streamBedrock } from "../../src/api/bedrock-converse-stream.ts";
import { getBuiltinModel as getModel } from "../../src/providers/all.ts";
import type { Model } from "../../src/types.ts";
import { normalizeContext } from "../../src/utils/transcript.ts";
import { hasBedrockCredentials } from "../bedrock-utils.ts";

describe.skipIf(!hasBedrockCredentials())("Bedrock Claude max tokens E2E", () => {
	it(
		"uses the model maxTokens cap instead of Bedrock's 4096-token default for adaptive Claude models",
		{ retry: 2, timeout: 180000 },
		async () => {
			const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6");
			const model: Model<"bedrock-converse-stream"> = {
				...baseModel,
				maxTokens: 6000,
			};

			const response = await streamBedrock(
				model,
				normalizeContext({
					systemPrompt: "You are a deterministic text generator. Follow the requested output format exactly.",
					messages: [
						{
							role: "user",
							content:
								"Output exactly 5200 repetitions of the token alpha, separated by single spaces. Do not number them. Do not use markdown. Do not add any other text.",
							timestamp: Date.now(),
						},
					],
				}),
				{ reasoning: "low" },
			).result();

			expect(response.stopReason, response.errorMessage).not.toBe("error");
			expect(response.usage.output).toBeGreaterThan(4096);
		},
	);
});
