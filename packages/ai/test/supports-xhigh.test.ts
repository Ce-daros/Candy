import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getSupportedThinkingLevels } from "../src/models.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
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
	it("provides GPT-6.1 Sol effort and request capabilities for OpenAI and Codex", () => {
		for (const provider of ["openai", "openai-codex"] as const) {
			const sol = getBuiltinModel(provider, "gpt-6.1-sol");
			expect(getSupportedThinkingLevels(sol)).toEqual(
				provider === "openai-codex"
					? ["minimal", "low", "medium", "high", "xhigh", "max"]
					: ["low", "medium", "high", "xhigh", "max"],
			);
			expect(sol.thinkingLevelMap?.off).toBeNull();
			const clamped = clampThinkingLevel(sol, "off");
			expect(sol.thinkingLevelMap?.[clamped]).toBe("low");
			expect(sol.cost).toMatchObject({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
			expect(sol.compat).toMatchObject({ supportsAdditionalTools: true, supportsMidConvoSystemMessages: true });
		}
	});
	it("provides Sonnet 5.5 adaptive thinking and native transcript capabilities", () => {
		const sonnet = getBuiltinModel("anthropic", "claude-sonnet-5-5");
		expect(getSupportedThinkingLevels(sonnet)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(sonnet.compat).toMatchObject({
			supportsTemperature: false,
			forceAdaptiveThinking: true,
			supportsMidConvoEffort: true,
			supportsMidConvoSystemMessages: true,
			supportsMidConvoToolChanges: true,
		});
	});
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
