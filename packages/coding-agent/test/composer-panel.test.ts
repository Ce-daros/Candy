import { CURSOR_MARKER, type TUI, visibleWidth } from "@candy/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerPanel, type PanelContent } from "../src/modes/interactive/components/composer-panel.ts";
import type { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

function createPanel() {
	const ui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI;
	const editor = {
		render: () => ["editor"],
		renderPanelFooter: (width: number) => "─".repeat(width),
		getFrameMotion: () => ({ setGeometry: vi.fn(), paintBorder: (text: string) => text }),
	} as unknown as CustomEditor;
	return { panel: new ComposerPanel(ui, editor), ui };
}

function content(label: string, count = 5) {
	return {
		focused: false,
		invalidate: vi.fn(),
		render: vi.fn(() =>
			Array.from({ length: count }, (_, row) => (row === 0 ? `${label}${CURSOR_MARKER}` : `${label} ${row}`)),
		),
		handleInput: vi.fn(),
		handleMouse: vi.fn(() => ({ handled: true })),
	};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("composer page motion", () => {
	it.each(["conservative", "moderate", "aggressive"] as const)(
		"uses the same opening frames for initial menus and page switches with %s intensity",
		(intensity) => {
			const initial = createPanel().panel;
			const switched = createPanel().panel;
			initial.setOptions(true, intensity);
			switched.setOptions(true, intensity);
			switched.show(content("previous"));
			vi.advanceTimersByTime(1104);
			switched.render(80);
			initial.show(content("target", 8));
			switched.show(content("target", 8));
			for (let elapsed = 0; elapsed <= 1104; elapsed += 48) {
				expect(switched.render(80)).toEqual(initial.render(80));
				vi.advanceTimersByTime(48);
			}
			initial.dispose();
			switched.dispose();
			expect(vi.getTimerCount()).toBe(0);
		},
	);
	it("closes from a snapshot without rendering or sending input to the disposed page", () => {
		const { panel } = createPanel();
		const page = content("History");
		panel.focused = true;
		panel.show(page);
		vi.advanceTimersByTime(816);
		panel.render(80);
		panel.close(vi.fn());
		page.render.mockImplementation(() => {
			throw new Error("disposed");
		});
		panel.handleInput("X");
		panel.invalidate();
		expect(page.handleInput).not.toHaveBeenCalled();
		expect(page.focused).toBe(false);
		expect(panel.render(80).join("\n")).not.toContain(CURSOR_MARKER);
		vi.advanceTimersByTime(96);
		expect(() => panel.render(80)).not.toThrow();
		panel.dispose();
	});
	it.each([80, 120])("switches to new input immediately and never renders a disposed page at width %s", (width) => {
		const { panel } = createPanel();
		const history = content("History");
		const details = content("Session", 8);
		panel.focused = true;
		panel.show(history);
		vi.advanceTimersByTime(816);
		panel.render(width);
		history.render.mockClear();
		panel.show(details);
		panel.handleInput("中文");
		expect(details.handleInput).toHaveBeenCalledWith("中文");
		expect(history.focused).toBe(false);
		expect(details.focused).toBe(true);
		const before = panel.render(width);
		expect(before.join("\n")).not.toContain("History");
		expect(before.join("\n")).not.toContain("Session");
		expect(before.join("\n")).not.toContain(CURSOR_MARKER);
		vi.advanceTimersByTime(168);
		const during = panel.render(width);
		expect(during[0]).not.toBe(before[0]);
		expect(during.every((line) => visibleWidth(line) <= width)).toBe(true);
		vi.advanceTimersByTime(648);
		expect(panel.render(width).join("\n")).toContain("Session 7");
		expect(history.render).not.toHaveBeenCalled();
		panel.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not animate a refresh, and reopening cancels an old close callback", () => {
		const { panel, ui } = createPanel();
		const history = content("History");
		panel.show(history);
		vi.advanceTimersByTime(816);
		panel.render(80);
		panel.show(history);
		expect(vi.getTimerCount()).toBe(0);
		const complete = vi.fn();
		panel.close(complete);
		vi.advanceTimersByTime(48);
		panel.show(history);
		vi.advanceTimersByTime(816);
		expect(complete).not.toHaveBeenCalled();
		expect(panel.render(80).join("\n")).toContain("History");
		expect(ui.requestRender).toHaveBeenCalled();
		panel.dispose();
	});

	it("resets its content after closing, so a later opening uses the entrance", () => {
		const { panel } = createPanel();
		const history = content("History");
		panel.setOptions(false, "moderate");
		panel.show(history);
		panel.render(80);
		panel.close(vi.fn());
		expect(panel.render(80)).toEqual(["editor"]);
		panel.setOptions(true, "moderate");
		panel.show(history);
		expect(panel.render(80).join("\n")).not.toContain("History");
		panel.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("updates inline edit states immediately without replaying the entrance or moving descriptions", () => {
		const { panel } = createPanel();
		let editing = false;
		const page: PanelContent = {
			invalidate: () => {},
			render: () => ["History", "New session    Candy", editing ? "Rename > 中文" : "Rename"],
			handleInput: () => {
				editing = !editing;
			},
		};
		panel.show(page);
		vi.advanceTimersByTime(816);
		panel.render(80);
		panel.handleInput("\r");
		const during = panel.render(80);
		expect(during[2]).toContain("New session    Candy");
		expect(during[3]).toContain("Rename > 中文");
		expect(vi.getTimerCount()).toBe(0);
		panel.handleInput("\x1b");
		expect(panel.render(80)[3]).toContain("Rename");
		expect(panel.render(80)[3]).not.toContain("中文");
		expect(vi.getTimerCount()).toBe(0);
		panel.dispose();
	});

	it("routes mouse events only to incoming visible rows during a transition", () => {
		const { panel } = createPanel();
		panel.show(content("History"));
		vi.advanceTimersByTime(816);
		panel.render(80);
		const target = content("Session");
		panel.show(target);
		panel.render(80);
		const event = {
			type: "press",
			button: "left",
			x: 4,
			y: 1,
			width: 80,
			height: 24,
			screenX: 4,
			screenY: 1,
			shift: false,
			alt: false,
			ctrl: false,
		} as const;
		panel.handleMouse(event);
		expect(target.handleMouse).not.toHaveBeenCalled();
		vi.advanceTimersByTime(648);
		panel.render(80);
		panel.handleMouse(event);
		expect(target.handleMouse).toHaveBeenCalledWith(expect.objectContaining({ x: 2, y: 0, width: 76 }));
		panel.dispose();
	});
});
