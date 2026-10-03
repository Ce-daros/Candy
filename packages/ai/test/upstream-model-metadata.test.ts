import { describe, expect, it } from "vitest";
import { getBuiltinModel, getBuiltinModels } from "../src/providers/all.ts";

describe("upstream model metadata fixes", () => {
	it("allows OpenCode Qwen empty thinking signatures", () => {
		for (const provider of ["opencode", "opencode-go"] as const) {
			expect(getBuiltinModel(provider, "qwen3.8-flash").compat).toMatchObject({ allowEmptySignature: true });
		}
	});
	it("sends dashed Anthropic model IDs through Cloudflare", () => {
		const models = getBuiltinModels("cloudflare-ai-gateway").filter((model) => model.api === "anthropic-messages");
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) expect(model.id).not.toContain(".");
	});
	it("uses the current Together model IDs and DeepSeek reasoning metadata", () => {
		expect(getBuiltinModel("together", "moonshotai/Kimi-K3").reasoning).toBe(true);
		const deepseek = getBuiltinModel("together", "deepseek-ai/DeepSeek-V4-Pro-0813");
		expect(deepseek.compat).toMatchObject({ thinkingFormat: "together", supportsReasoningEffort: true });
		expect(deepseek.thinkingLevelMap).toMatchObject({
			high: "high",
			minimal: null,
			low: null,
			medium: null,
			xhigh: null,
		});
	});
});
