import { setKeybindings, type TUI } from "@candy/tui";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function selectedModelName(rendered: string): string | undefined {
	const line = rendered.split("\n").find((value) => value.includes("│ ♦ "));
	const modelColumn = line?.split("│ ")[1];
	return modelColumn
		?.replace(/^♦\s*/, "")
		.split(/\s+✓|\s+· default|\s+♦$/)[0]
		?.trim();
}

describe("model selector filter resets selection to top", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterAll(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("moves selection to the first row in the All tab when typing a query", async () => {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "alpha-2", name: "Alpha Two", reasoning: true },
				{ id: "alpha-3", name: "Alpha Three", reasoning: true },
				{ id: "beta-1", name: "Beta One", reasoning: true },
			],
		});
		harnesses.push(harness);

		const current = harness.getModel("alpha-1")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.session.modelRuntime,
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Model catalogs refreshed.");
		});

		// Current model (alpha-1) is sorted first, so selection starts on row 0.
		expect(selectedModelName(stripAnsi(selector.render(120).join("\n")))).toBe("Alpha One");

		// Model names sort alphabetically, so two moves select Alpha Two.
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		expect(selectedModelName(stripAnsi(selector.render(120).join("\n")))).toBe("Alpha Two");

		// Type a query that matches the three alpha models. The selection must
		// move back to the top row (Alpha One), not stay clamped at index 2.
		for (const char of "alpha") {
			selector.handleInput(char);
		}

		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(selectedModelName(rendered)).toBe("Alpha One");
		// Sanity: the filter actually narrowed the list.
		expect(rendered).not.toContain("beta-1");
	});
});
