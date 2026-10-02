import { afterEach, describe, expect, it, vi } from "vitest";
import { PowerbarController, type PowerbarHost } from "../../../src/modes/interactive/components/powerbar.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #7443 cached Powerbar models", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	// Regression for #7443: opening the quick selector must not wait on a catalog request.
	it("browses the available snapshot without refreshing the catalog", async () => {
		initTheme(undefined, false);
		harness = await createHarness({ models: [{ id: "cached", name: "Cached" }] });
		const refresh = vi
			.spyOn(harness.session.execution.modelRuntime, "refresh")
			.mockImplementation(() => new Promise(() => {}));
		const runtime = harness.session.execution.modelRuntime;
		const host: PowerbarHost = {
			requestRender() {},
			getModels: () =>
				runtime
					.getAvailableSnapshot()
					.filter((model) => model.id === "cached")
					.map((model) => ({ model, label: model.name })),
			getCurrentModelIndex: () => 0,
			applyModel() {},
		};
		const powerbar = new PowerbarController(host);
		powerbar.render(80);
		powerbar.openModelBrowse({ anchorWidth: 8 });

		expect(powerbar.getHighlightedModel()?.id).toBe("cached");
		expect(refresh).not.toHaveBeenCalled();
	});
});
