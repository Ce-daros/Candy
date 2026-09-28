import type { Model } from "@candy/ai/compat";
import { describe, expect, it } from "vitest";
import { PowerbarController, type PowerbarHost } from "../../../src/modes/interactive/components/powerbar.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

describe("Powerbar model search selection", () => {
	// Regression for #7209: filtering must choose the first match, not retain a stale row index.
	it("resets the highlight to the first match when a query starts", () => {
		initTheme(undefined, false);
		const models = ["Alpha One", "Alpha Two", "Alpha Three", "Beta One"].map((name, index) => ({
			model: { provider: "test", id: `model-${index}`, name } as Model<any>,
			label: name,
		}));
		const host: PowerbarHost = {
			requestRender() {},
			getThinkingLevels: () => ["off"],
			getThinkingLevel: () => "off",
			getModels: () => models,
			getCurrentModelIndex: () => 0,
			applyThinking() {},
			applyModel() {},
		};
		const powerbar = new PowerbarController(host);
		powerbar.render(120);
		powerbar.openModelBrowse({ anchorWidth: 9 });
		powerbar.move(2);
		expect(powerbar.getHighlightedModel()?.name).toBe("Alpha Three");

		for (const char of "alpha") powerbar.inputChar(char);

		expect(powerbar.getHighlightedModel()?.name).toBe("Alpha One");
		expect(powerbar.capture()?.query).toBe("alpha");
	});
});
