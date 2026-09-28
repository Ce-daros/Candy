import { setKeybindings, type TUI, type TuiMouseEvent } from "@candy/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps the current model marked while browsing", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			() => {},
			() => {},
		);

		const getModelRow = (name: string): string | undefined =>
			stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((line) => line.includes(name))
				?.trimEnd();

		expect(getModelRow("Current Model")).toContain("♦ Current Model");
		expect(getModelRow("Current Model")).toContain("✓");
		selector.handleInput("\x1b[B");
		expect(getModelRow("Current Model")).not.toContain("♦ Current Model");
		expect(getModelRow("Browsed Model")).toContain("♦ Browsed Model");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain(`${currentModel.provider}/browsed-model`);
		selector.dispose();
	});

	it("uses the configured save binding", async () => {
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r" }));
		harness = await createHarness();
		const currentModel = harness.getModel()!;
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			() => {},
			() => {},
			undefined,
			saveDefault,
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Ctrl+R set default");
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith(currentModel);
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});

	it("disambiguates duplicate names and searches their IDs at narrow widths", async () => {
		harness = await createHarness({
			models: [
				{ id: "alpha-one", name: "Alpha", reasoning: true },
				{ id: "alpha-two", name: "Alpha", reasoning: true },
			],
		});
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("alpha-one"),
			harness.session.modelRuntime,
			() => {},
			() => {},
		);
		let output = stripAnsi(selector.render(80).join("\n"));
		expect(output).toContain("Alpha · alpha-one");
		expect(output).toContain("Alpha · alpha-two");
		for (const character of "alpha-two") selector.handleInput(character);
		output = stripAnsi(selector.render(80).join("\n"));
		expect(output).toContain("Alpha · alpha-two");
		expect(output).not.toContain("Alpha · alpha-one");
		selector.dispose();
	});

	it("keeps the selected provider visible in wide and narrow layouts", () => {
		const models = Array.from({ length: 18 }, (_, index) => ({
			provider: `provider-${String(index).padStart(2, "0")}`,
			id: "model",
			name: "Model",
			contextWindow: 1000,
			maxTokens: 100,
			reasoning: false,
		}));
		const runtime = {
			getAvailableSnapshot: () => models,
			refresh: () => new Promise<never>(() => {}),
		} as unknown as ModelRuntime;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			runtime,
			() => {},
			() => {},
		);
		selector.setAvailableHeight(17);
		selector.handleInput("\x1b[Z");
		for (let index = 0; index < 12; index++) selector.handleInput("\x1b[B");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("♦ provider-11 ♦");
		expect(stripAnsi(selector.render(70).join("\n"))).toContain("♦ provider-11 ♦");
		selector.render(120);
		const click: TuiMouseEvent = {
			type: "press",
			button: "left",
			x: 3,
			y: 2,
			screenX: 3,
			screenY: 2,
			width: 120,
			height: 17,
			shift: false,
			alt: false,
			ctrl: false,
		};
		selector.handleMouse(click);
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("♦ provider-07 ♦");
		selector.dispose();
	});
});
