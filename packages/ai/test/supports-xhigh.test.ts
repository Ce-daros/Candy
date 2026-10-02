import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getSupportedThinkingLevels } from "../src/models.ts";
import type { Model } from "../src/types.ts";

const model: Model<"openai-completions"> = {
	id: "test",
	name: "Test",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

describe("supported thinking levels", () => {
	it("returns only off for models without reasoning even when metadata defines effort", () => {
		const plain = { ...model, reasoning: false, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
		expect(getSupportedThinkingLevels(plain)).toEqual(["off"]);
		expect(clampThinkingLevel(plain, "high")).toBe("off");
	});

	it("opts into extended effort and removes explicitly unsupported levels", () => {
		const extended = { ...model, thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" } };
		expect(getSupportedThinkingLevels(extended)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(clampThinkingLevel(extended, "off")).toBe("low");
		expect(clampThinkingLevel(extended, "max")).toBe("max");
	});

	it("keeps aliases selectable and orders levels independently of metadata key order", () => {
		expect(
			getSupportedThinkingLevels({
				...model,
				thinkingLevelMap: { max: "max", high: "high", low: "high", medium: null, minimal: null, off: null },
			}),
		).toEqual(["low", "high", "max"]);
	});
});
