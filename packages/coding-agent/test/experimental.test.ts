import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalCandyExperimental = process.env.CANDY_EXPERIMENTAL;

	afterEach(() => {
		if (originalCandyExperimental === undefined) {
			delete process.env.CANDY_EXPERIMENTAL;
		} else {
			process.env.CANDY_EXPERIMENTAL = originalCandyExperimental;
		}
	});

	it("returns false when CANDY_EXPERIMENTAL is unset", () => {
		delete process.env.CANDY_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when CANDY_EXPERIMENTAL is empty", () => {
		process.env.CANDY_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when CANDY_EXPERIMENTAL is set to 1", () => {
		process.env.CANDY_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when CANDY_EXPERIMENTAL is set to 0", () => {
		process.env.CANDY_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when CANDY_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.CANDY_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
