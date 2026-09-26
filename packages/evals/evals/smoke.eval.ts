import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createCandyCodingAgentHarness } from "../src/harness.ts";

const harness = createCandyCodingAgentHarness({ noTools: "all" });

describeEval("Answer a basic prompt", { harness }, (it) => {
	it("returns the expected answer", async ({ run }) => {
		const result = await run("What's the capital of France? Respond with only the city name.");
		expect(result.output.trim()).toBe("Paris");
		expect(result.errors).toEqual([]);
		expect(result.usage).toMatchObject({
			provider: process.env.CANDY_PROVIDER,
			model: process.env.CANDY_MODEL,
		});
		expect(result.usage.totalTokens).toBeGreaterThan(0);
	});
});
