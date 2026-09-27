import type { ThinkingLevel } from "@candy/agent-core";
import type { Model } from "@candy/ai/compat";
import { visibleWidth } from "@candy/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import {
	PowerbarController,
	type PowerbarHost,
	type PowerbarModelEntry,
} from "../src/modes/interactive/components/powerbar.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function createModel(id: string, name: string): Model<any> {
	return {
		id,
		name,
		provider: "test",
		api: "openai-completions",
		contextWindow: 200_000,
		reasoning: true,
	} as Model<any>;
}

const MODELS: PowerbarModelEntry[] = [
	{ model: createModel("gpt-5.6-sol", "GPT-5.6 Sol"), label: "GPT-5.6 Sol" },
	{ model: createModel("kimi-k2.6", "Kimi K2.6"), label: "Kimi K2.6" },
	{ model: createModel("sonnet-4.6", "Sonnet 4.6"), label: "Sonnet 4.6" },
	{ model: createModel("sonnet-4.5", "Sonnet 4.5"), label: "Sonnet 4.5" },
	{ model: createModel("gemini-3.1-pro", "Gemini 3.1 Pro"), label: "Gemini 3.1 Pro" },
];

/** Wide model list that overflows narrow terminals, for window-slide tests. */
const MANY_MODELS: PowerbarModelEntry[] = Array.from({ length: 12 }, (_, i) => {
	const label = `Model ${String(i + 1).padStart(2, "0")}`;
	return { model: createModel(`model-${i + 1}`, label), label };
});

interface AppliedSelection {
	level?: ThinkingLevel;
	modelId?: string;
	persist?: boolean;
}

interface PowerbarFixture {
	controller: PowerbarController;
	applied: AppliedSelection[];
	setCurrentLevel: (level: ThinkingLevel) => void;
	setCurrentModelIndex: (index: number) => void;
	setModels: (models: readonly PowerbarModelEntry[]) => void;
}

function createFixture(): PowerbarFixture {
	const applied: AppliedSelection[] = [];
	let currentLevel: ThinkingLevel = "medium";
	let currentModelIndex = 1;
	let models: readonly PowerbarModelEntry[] = MODELS;
	const host: PowerbarHost = {
		requestRender: () => {},
		getThinkingLevels: () => [...LEVELS],
		getThinkingLevel: () => currentLevel,
		getModels: () => models,
		getCurrentModelIndex: () => currentModelIndex,
		applyThinking: (level, persist) => {
			currentLevel = level;
			applied.push({ level, persist });
		},
		applyModel: (model) => {
			applied.push({ modelId: model.id });
			currentModelIndex = models.findIndex((entry) => entry.model.id === model.id);
		},
	};
	return {
		controller: new PowerbarController(host),
		applied,
		setCurrentLevel(level: ThinkingLevel): void {
			currentLevel = level;
		},
		setCurrentModelIndex(index: number): void {
			currentModelIndex = index;
		},
		setModels(next: readonly PowerbarModelEntry[]): void {
			models = next;
		},
	};
}

/** Advance the controller through all pending animation frames. */
function settle(controller: PowerbarController): void {
	for (let i = 0; i < 40 && !controller.isIdle(); i++) {
		vi.advanceTimersByTime(40);
	}
}

/** Visible item labels of the current frame, e.g. ["‹ Medium ›", "High"]. */
function frameItems(controller: PowerbarController): string[] {
	const rendered = controller.render(200);
	expect(rendered).toBeDefined();
	return stripAnsi(rendered!.text)
		.split(/\s{3,}/)
		.filter((part) => part.trim().length > 0)
		.map((part) => part.trim());
}

function frameWidth(controller: PowerbarController): number {
	return visibleWidth(stripAnsi(controller.render(200)!.text));
}

describe("PowerbarController thinking track", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		initTheme(undefined, false);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function open(controller: PowerbarController): void {
		controller.render(200);
		controller.openThinking({ anchorWidth: 9, prefix: { text: "Kimi K2.6 ▾", width: 11 } });
	}

	it("eases the track open: the anchor is immediate, neighbors follow over frames", () => {
		const { controller } = createFixture();
		open(controller);

		// First frame: only the anchor (its slot still morphing from the label).
		const items = frameItems(controller);
		expect(items.some((item) => item.includes("Medium"))).toBe(true);
		expect(items.some((item) => item.includes("High"))).toBe(false);

		// The rendered track grows monotonically while the anchor stays visible.
		let previous = frameWidth(controller);
		for (let frame = 0; frame < 6; frame++) {
			const rendered = controller.render(200)!;
			const text = stripAnsi(rendered.text);
			expect(text).toContain("Medium");
			const width = visibleWidth(text);
			expect(width).toBeGreaterThanOrEqual(previous);
			previous = width;
			vi.advanceTimersByTime(30);
		}

		// Fully expanded: every level is on screen with the model prefix.
		const text = stripAnsi(controller.render(200)!.text);
		for (const level of ["Off", "Minimal", "Low", "Medium", "High", "Xhigh", "Max"]) {
			expect(text).toContain(level);
		}
		expect(text).toContain("Kimi K2.6");
		expect(controller.isIdle()).toBe(false);
		expect(controller.mode).toBe("thinking");
	});

	it("confirm applies the level and collapses anchored on it", () => {
		const { controller, applied } = createFixture();
		open(controller);
		settle(controller);
		controller.move(1); // highlight High
		controller.confirm();

		expect(applied).toEqual([{ level: "high", persist: false }]);
		expect(controller.mode).toBe("thinking");

		// The collapse keeps the new anchor highlighted until the final swap.
		const mid = stripAnsi(controller.render(200)!.text);
		expect(mid).toContain("‹ High ›");

		settle(controller);
		expect(controller.isIdle()).toBe(true);
		expect(controller.mode).toBe("normal");
	});

	it("cancel collapses without applying anything", () => {
		const { controller, applied } = createFixture();
		open(controller);
		settle(controller);
		controller.move(2);
		controller.collapse();
		settle(controller);
		expect(applied).toEqual([]);
		expect(controller.isIdle()).toBe(true);
	});

	it("shows the final track immediately when animations are disabled", () => {
		const { controller } = createFixture();
		controller.setAnimationOptions(false, "conservative");
		open(controller);
		const text = stripAnsi(controller.render(200)!.text);
		expect(text).toContain("Off");
		expect(text).toContain("Max");
		controller.confirm();
		expect(controller.isIdle()).toBe(true);
	});

	it("keeps the anchor visible in every expansion frame", () => {
		const { controller } = createFixture();
		open(controller);
		for (let frame = 0; frame < 7; frame++) {
			const text = stripAnsi(controller.render(200)!.text);
			expect(text).toContain("Medium");
			vi.advanceTimersByTime(30);
		}
	});

	it("frames never exceed the available width", () => {
		const { controller } = createFixture();
		open(controller);
		for (let frame = 0; frame < 8; frame++) {
			const rendered = controller.render(40);
			expect(visibleWidth(stripAnsi(rendered!.text))).toBeLessThanOrEqual(40);
			vi.advanceTimersByTime(30);
		}
	});
});

describe("PowerbarController model track", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		initTheme(undefined, false);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("expands the model track around the current model", () => {
		const { controller } = createFixture();
		controller.render(200);
		controller.openModelBrowse({ anchorWidth: 11 });
		settle(controller);
		const items = frameItems(controller);
		expect(items).toContain("‹ Kimi K2.6 ›");
		expect(items).toContain("Sonnet 4.6");
		expect(items).toContain("Sonnet 4.5");
		expect(items).toContain("Gemini 3.1 Pro");
		expect(items).toContain("GPT-5.6 Sol");
	});

	it("middle-truncates overlong model labels so neighbors stay visible", () => {
		const longLabel = "Mistral Medium 3.1 (batch)";
		const { controller, setModels } = createFixture();
		setModels([
			{ model: createModel("long", longLabel), label: longLabel },
			{ model: createModel("b", "B"), label: "B" },
			{ model: createModel("c", "C"), label: "C" },
		]);
		controller.render(200);
		controller.openModelBrowse({ anchorWidth: 11 });
		settle(controller);

		const text = stripAnsi(controller.render(200)!.text);
		expect(text).toContain("…");
		expect(text).not.toContain(longLabel);
		// Neighbors are not squeezed out by the long slot.
		expect(text).toContain("B");
		expect(text).toContain("C");
	});

	it("middle truncation keeps the head and tail of the label", () => {
		const longLabel = "Mistral Medium 3.1 (batch)";
		const { controller, setModels } = createFixture();
		setModels([{ model: createModel("long", longLabel), label: longLabel }]);
		controller.render(200);
		controller.openModelBrowse({ anchorWidth: 11 });
		settle(controller);

		const text = stripAnsi(controller.render(200)!.text);
		expect(text).toContain("Mistral");
		expect(text).toContain("(batch)");
	});

	it("morphs into search on the first keystroke and filters", () => {
		const { controller } = createFixture();
		controller.render(200);
		controller.openModelBrowse({ anchorWidth: 11 });
		settle(controller);
		controller.inputChar("s");
		controller.inputChar("o");
		controller.inputChar("n");
		expect(controller.mode).toBe("model-search");
		settle(controller);
		const text = stripAnsi(controller.render(200)!.text);
		expect(text).toContain("Model › son");
		expect(text).toContain("Sonnet 4.6");
		expect(text).not.toContain("Kimi K2.6");
	});

	it("backspacing the query empty morphs back to the browse track", () => {
		const { controller } = createFixture();
		controller.render(200);
		controller.openModelBrowse({ anchorWidth: 11 });
		settle(controller);
		controller.inputChar("s");
		settle(controller);
		controller.backspace();
		expect(controller.mode).toBe("model-browse");
		settle(controller);
		const text = stripAnsi(controller.render(200)!.text);
		for (const label of ["GPT-5.6 Sol", "Kimi K2.6", "Sonnet 4.6", "Sonnet 4.5", "Gemini 3.1 Pro"]) {
			expect(text).toContain(label);
		}
	});

	it("shows a no-match hint when the query matches nothing", () => {
		const { controller } = createFixture();
		controller.render(200);
		controller.openModelBrowse({ anchorWidth: 11 });
		controller.inputChar("z");
		settle(controller);
		controller.inputChar("z");
		settle(controller);
		const text = stripAnsi(controller.render(200)!.text);
		expect(text).toContain("Model › zz");
		expect(text).toContain("no match");
	});

	it("confirm applies the selected model and collapses", () => {
		const { controller, applied, setCurrentModelIndex } = createFixture();
		setCurrentModelIndex(1);
		controller.openModelBrowse({ anchorWidth: 11 });
		settle(controller);
		controller.move(-1); // highlight GPT-5.6 Sol
		controller.confirm();
		expect(applied).toEqual([{ modelId: "gpt-5.6-sol" }]);
		settle(controller);
		expect(controller.isIdle()).toBe(true);
	});
});

describe("PowerbarController window sliding", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		initTheme(undefined, false);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps the selection on screen while scrolling right through many models", () => {
		const { controller, setCurrentModelIndex, setModels } = createFixture();
		setCurrentModelIndex(0);
		setModels(MANY_MODELS);
		controller.render(80);
		controller.openModelBrowse({ anchorWidth: 11 });
		settle(controller);

		// The window cannot hold all twelve models at width 80.
		const full = stripAnsi(controller.render(80)!.text);
		expect(full).not.toContain("Model 12");

		// Walking right keeps the highlighted model rendered once its slide-in
		// finishes, and the window slides along (the left marker appears).
		for (let step = 1; step < MANY_MODELS.length; step++) {
			controller.move(1);
			settle(controller);
			const label = `Model ${String(step + 1).padStart(2, "0")}`;
			expect(stripAnsi(controller.render(80)!.text)).toContain(label);
			// Mid-animation frames never exceed the width.
			controller.move(1);
			const mid = stripAnsi(controller.render(80)!.text);
			expect(visibleWidth(mid)).toBeLessThanOrEqual(80);
			controller.move(-1);
			settle(controller);
		}
		controller.move(1);
		settle(controller);
		expect(stripAnsi(controller.render(80)!.text)).toContain("‹");
	});

	it("scrolls back left and drops the left marker at the window start", () => {
		const { controller, setCurrentModelIndex, setModels } = createFixture();
		setCurrentModelIndex(0);
		setModels(MANY_MODELS);
		controller.render(80);
		controller.openModelBrowse({ anchorWidth: 11 });
		settle(controller);
		for (let step = 0; step < 6; step++) {
			controller.move(1);
			settle(controller);
		}
		expect(stripAnsi(controller.render(80)!.text)).toContain("‹");
		for (let step = 0; step < 6; step++) {
			controller.move(-1);
			settle(controller);
		}
		const text = stripAnsi(controller.render(80)!.text);
		// Back at the window start the left marker is gone; the leading bracket
		// belongs to the selected item.
		expect(text.startsWith("‹ Model 01 ›")).toBe(true);
	});
});

describe("PowerbarController clicks", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		initTheme(undefined, false);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("confirms a clicked item via its render region", () => {
		const { controller, applied } = createFixture();
		controller.render(200);
		controller.openThinking({ anchorWidth: 9, prefix: { text: "Kimi K2.6 ▾", width: 11 } });
		settle(controller);
		const { regions } = controller.render(200)!;
		const xhigh = regions.find((region) => region.itemIndex === LEVELS.indexOf("xhigh"));
		expect(xhigh).toBeDefined();
		controller.handleContentClick(xhigh!.start + 1);
		expect(applied).toEqual([{ level: "xhigh", persist: false }]);
	});

	it("collapses when clicking outside any item", () => {
		const { controller, applied } = createFixture();
		controller.render(200);
		controller.openThinking({ anchorWidth: 9, prefix: { text: "Kimi K2.6 ▾", width: 11 } });
		settle(controller);
		controller.handleContentClick(10_000);
		settle(controller);
		expect(applied).toEqual([]);
		expect(controller.isIdle()).toBe(true);
	});
});

describe("FooterComponent powerbar integration", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		initTheme(undefined, false);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createFooterSession(): AgentSession {
		const session = {
			state: {
				model: {
					id: "kimi-k2.6",
					name: "Kimi K2.6",
					provider: "test",
					contextWindow: 200_000,
					reasoning: true,
				},
				thinkingLevel: "medium",
			},
			getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		};
		return session as unknown as AgentSession;
	}

	function createPowerbarHost(): PowerbarHost {
		return {
			requestRender: () => {},
			getThinkingLevels: () => [...LEVELS],
			getThinkingLevel: () => "medium",
			getModels: () => MODELS,
			getCurrentModelIndex: () => 1,
			applyThinking: () => {},
			applyModel: () => {},
		};
	}

	it("renders the normal border and exact width when idle", () => {
		const footer = new FooterComponent(createFooterSession(), createPowerbarHost());
		expect(footer.isPowerbarIdle()).toBe(true);
		for (const width of [20, 40, 60, 120, 200]) {
			const line = footer.renderBottomBorder(width, 0, (text) => text);
			expect(visibleWidth(stripAnsi(line))).toBe(width);
		}
	});

	it("opens the model track from a click on the model label", () => {
		const fixture = createFixture();
		const footer = new FooterComponent(createFooterSession(), createPowerbarHost());
		footer.renderBottomBorder(120, 0, (text) => text);
		// Content starts after the "╰── " corner; the model label starts at 0.
		expect(footer.handleBottomBorderClick(4)).toBe(true);
		expect(footer.isPowerbarIdle()).toBe(false);
		vi.advanceTimersByTime(300);
		const line = footer.renderBottomBorder(120, 0, (text) => text);
		expect(stripAnsi(line)).toContain("‹ Kimi K2.6 ›");
		// The line still fills the width while the track is open.
		expect(visibleWidth(stripAnsi(line))).toBe(120);
		settle(fixture.controller);
	});

	it("opens the thinking track from a click on the thinking label", () => {
		const fixture = createFixture();
		const footer = new FooterComponent(createFooterSession(), createPowerbarHost());
		footer.renderBottomBorder(120, 0, (text) => text);
		// Thinking label starts after the model label and a three-space gap.
		const modelLabelWidth = visibleWidth("Kimi K2.6 ▾");
		expect(footer.handleBottomBorderClick(4 + modelLabelWidth + 3)).toBe(true);
		vi.advanceTimersByTime(300);
		const line = footer.renderBottomBorder(120, 0, (text) => text);
		expect(stripAnsi(line)).toContain("Kimi K2.6");
		expect(stripAnsi(line)).toContain("‹ Medium ›");
		settle(fixture.controller);
	});

	it("discards an unconfirmed model selection when Tab changes selector", () => {
		const footer = new FooterComponent(createFooterSession(), createPowerbarHost());
		footer.setAnimationOptions(false, "moderate");
		footer.openPowerbarModelBrowse();
		footer.movePowerbar(1);
		footer.switchPowerbar(1);
		expect(stripAnsi(footer.renderBottomBorder(120, 0, (text) => text))).toContain("‹ Medium ›");
		footer.switchPowerbar(-1);
		expect(stripAnsi(footer.renderBottomBorder(120, 0, (text) => text))).toContain("‹ Kimi K2.6 ›");
		footer.dispose();
	});

	it("keeps the model selector open when reasoning is unavailable", () => {
		const session = createFooterSession();
		session.state.model!.reasoning = false;
		const footer = new FooterComponent(session, createPowerbarHost());
		footer.setAnimationOptions(false, "moderate");
		footer.openPowerbarModelBrowse();
		footer.switchPowerbar(1);
		expect(stripAnsi(footer.renderBottomBorder(120, 0, (text) => text))).toContain("‹ Kimi K2.6 ›");
		footer.dispose();
	});

	it("keeps exact border width while tracks animate", () => {
		const fixture = createFixture();
		const footer = new FooterComponent(createFooterSession(), createPowerbarHost());
		footer.handleBottomBorderClick(4);
		for (let frame = 0; frame < 8; frame++) {
			for (const width of [30, 44, 60, 93, 120, 200]) {
				const line = footer.renderBottomBorder(width, 0, (text) => text);
				expect(visibleWidth(stripAnsi(line)), `width ${width}`).toBe(width);
			}
			vi.advanceTimersByTime(30);
		}
		settle(fixture.controller);

		footer.movePowerbar(1);
		for (let frame = 0; frame < 6; frame++) {
			for (const width of [30, 60, 120]) {
				const line = footer.renderBottomBorder(width, 0, (text) => text);
				expect(visibleWidth(stripAnsi(line)), `width ${width}`).toBe(width);
			}
			vi.advanceTimersByTime(30);
		}
		settle(fixture.controller);
	});
});
