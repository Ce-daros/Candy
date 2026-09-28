import { describe, expect, it } from "vitest";
import { hasApi } from "../src/models.ts";
import { getBuiltinModels as getModels, getBuiltinProviders as getProviders } from "../src/providers/all.ts";
import type { Api, Model } from "../src/types.ts";

function getAllModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => getModels(provider) as Model<Api>[]);
}

// Mirrors isAnthropicAdaptiveThinkingModel() in scripts/generate-models.ts: the
// generator flags Messages models by id pattern, so the test asserts the same
// patterns against the whole generated catalog instead of pinning model ids
// (the catalog refreshes on every models.dev run and exact ids churn).
const ADAPTIVE_FAMILIES = /claude-(opus-4[.-][678]|opus[.-]5|sonnet-4[.-]6|sonnet[.-]5|fable-5|mythos-5)/;
// Families the generator deliberately keeps on budget-based thinking.
const NON_ADAPTIVE_FAMILIES = /claude-(haiku|opus-4[.-]5|sonnet-4[.-]5)/;

describe("Anthropic adaptive thinking model metadata", () => {
	it("marks built-in Anthropic Messages models that use adaptive thinking", () => {
		const messagesModels = getAllModels().filter((model) => hasApi(model, "anthropic-messages"));
		expect(messagesModels.length).toBeGreaterThan(0);

		let flaggedCount = 0;
		for (const model of messagesModels) {
			const flagged = model.compat?.forceAdaptiveThinking === true;
			if (flagged) flaggedCount++;

			if (NON_ADAPTIVE_FAMILIES.test(model.id)) {
				expect(flagged, model.id).toBe(false);
			} else if (ADAPTIVE_FAMILIES.test(model.id)) {
				expect(flagged, model.id).toBe(true);
			}

			// A flag outside the pattern-based claude families is only justified
			// for providers whose policy comes from catalog metadata instead of
			// names: Fireworks derives it from effort reasoning options, and
			// Kimi Coding is always adaptive (#9323).
			if (flagged) {
				expect(
					ADAPTIVE_FAMILIES.test(model.id) || model.provider === "fireworks" || model.provider === "kimi-coding",
					model.id,
				).toBe(true);
			}
		}
		expect(flaggedCount).toBeGreaterThan(0);

		// Kimi Coding is always adaptive (generator sets the flag unconditionally).
		for (const model of messagesModels.filter((candidate) => candidate.provider === "kimi-coding")) {
			expect(model.compat?.forceAdaptiveThinking, model.id).toBe(true);
		}
	});
});
