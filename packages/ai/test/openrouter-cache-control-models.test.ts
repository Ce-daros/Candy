import { describe, expect, it } from "vitest";
import { getBuiltinModel as getModel } from "../src/providers/all.ts";

const OPENROUTER_ANTHROPIC_LATEST_MODEL_IDS = [
	"~anthropic/claude-fable-latest",
	"~anthropic/claude-haiku-latest",
	"~anthropic/claude-opus-latest",
	"~anthropic/claude-sonnet-latest",
] as const;

describe("OpenRouter Anthropic latest alias metadata", () => {
	it.each(OPENROUTER_ANTHROPIC_LATEST_MODEL_IDS)("keeps completions cache control for %s", (modelId) => {
		const model = getModel("openrouter", modelId);
		expect(model.api).toBe("openai-completions");
		if (model.api !== "openai-completions") throw new Error(`Unexpected API for ${modelId}`);
		expect(model.compat?.cacheControlFormat).toBe("anthropic");
	});
});
