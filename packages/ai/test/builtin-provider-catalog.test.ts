import { describe, expect, it } from "vitest";
import { CLASSIFIER_MODELS, IMAGE_MODELS, MODELS } from "../src/models.generated.ts";
import { builtinProviders } from "../src/providers/all.ts";

describe("built-in provider catalog", () => {
	it("has exactly one factory for every generated provider", () => {
		const factoryIds = builtinProviders().map((provider) => provider.id);
		const catalogIds = new Set([
			...Object.keys(MODELS),
			...Object.keys(IMAGE_MODELS),
			...Object.keys(CLASSIFIER_MODELS),
		]);

		expect(new Set(factoryIds).size).toBe(factoryIds.length);
		expect(factoryIds.toSorted()).toEqual([...catalogIds].toSorted());
	});
});
