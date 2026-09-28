import { type Component, type TUI, visibleWidth } from "@candy/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ComposerPanel } from "../src/modes/interactive/components/composer-panel.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { PanelTransition } from "../src/modes/interactive/components/panel-transition.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function editor(): { editor: CustomEditor; ui: TUI } {
	initTheme("dark", false);
	const ui = { requestRender: () => {}, terminal: { rows: 50 } } as TUI;
	const editor = new CustomEditor(ui, getEditorTheme(), new KeybindingsManager());
	editor.setAnimationOptions(false, "moderate");
	return { editor, ui };
}

afterEach(() => vi.useRealTimers());

describe("composer redesign", () => {
	it("expands image labels on submission and restores their registry after undo", () => {
		const { editor: input } = editor();
		input.insertImageAtCursor("C:/images/screen.png", { width: 1920, height: 1080 });
		expect(input.getText()).toBe("[Image #1 1920×1080]");
		expect(input.getExpandedText()).toBe("C:/images/screen.png");
		input.handleInput("\x7f");
		expect(input.getText()).toBe("");
		// TUI defaults bind undo to Ctrl+- independently of app platform settings.
		input.handleInput("\x1f");
		expect(input.getExpandedText()).toBe("C:/images/screen.png");
		input.dispose();
	});

	it("colors the entire wrapped @path and leaves ordinary text in the text color", () => {
		const { editor: input } = editor();
		input.setText('@"src/a very long directory/中文/file.ts" text');
		const lines = input.render(26);
		expect(lines[1]).toContain(theme.getFgAnsi("warning"));
		expect(lines[2]).toContain(theme.getFgAnsi("warning"));
		expect(lines.every((line) => visibleWidth(line) === 26)).toBe(true);
		input.dispose();
	});

	it("preserves editor text, cursor and paste registry across a panel", () => {
		const { editor: input, ui } = editor();
		input.handleInput(`\x1b[200~${"draft\n".repeat(20)}\x1b[201~`);
		input.handleInput("\x1b[D");
		const text = input.getText();
		const expanded = input.getExpandedText();
		const cursor = input.getCursor();
		const panel = new ComposerPanel(ui, input);
		panel.setOptions(false, "moderate");
		panel.show({ render: () => ["Settings"], invalidate: () => {} } satisfies Component);
		const rows = panel.render(120);
		expect(rows).toHaveLength(40);
		expect(rows.every((line) => visibleWidth(line) === 120)).toBe(true);
		expect(stripAnsi(rows[1]!)).toContain("Settings");
		let closed = false;
		panel.close(() => {
			closed = true;
		});
		expect(closed).toBe(true);
		expect(input.getText()).toBe(text);
		expect(input.getExpandedText()).toBe(expanded);
		expect(input.getCursor()).toEqual(cursor);
		panel.dispose();
		input.dispose();
	});

	it("reverses an interrupted panel from its current position", () => {
		vi.useFakeTimers();
		const motion = new PanelTransition(() => {});
		motion.setOpen(true);
		vi.advanceTimersByTime(320);
		const opening = motion.value();
		motion.setOpen(false);
		expect(motion.value()).toBe(opening);
		vi.advanceTimersByTime(100);
		expect(motion.value()).toBeLessThan(opening);
		const closing = motion.value();
		motion.setOpen(true);
		expect(motion.value()).toBe(closing);
		vi.advanceTimersByTime(800);
		expect(motion.value()).toBe(1);
		motion.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("runs the latest close callback when close is requested again during a transition", () => {
		vi.useFakeTimers();
		const motion = new PanelTransition(() => {});
		motion.setOpen(true);
		vi.advanceTimersByTime(400);
		const old = vi.fn();
		const latest = vi.fn();
		motion.setOpen(false, old);
		motion.setOpen(false, latest);
		vi.advanceTimersByTime(600);
		expect(old).not.toHaveBeenCalled();
		expect(latest).toHaveBeenCalledOnce();
		motion.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps a resized panel aligned while closing and reopening with new content", () => {
		vi.useFakeTimers();
		const { editor: input, ui } = editor();
		const panel = new ComposerPanel(ui, input);
		panel.show({ render: () => ["Settings"], invalidate: () => {} });
		vi.advanceTimersByTime(420);
		Object.assign(ui.terminal, { rows: 24 });
		expect(panel.render(80).every((line) => visibleWidth(line) === 80)).toBe(true);
		const closed = vi.fn();
		panel.close(closed);
		vi.advanceTimersByTime(50);
		panel.show({ render: () => ["Model"], invalidate: () => {} });
		vi.advanceTimersByTime(800);
		const rendered = panel.render(80);
		expect(rendered).toHaveLength(19);
		expect(rendered.map(stripAnsi).join("\n")).toContain("Model");
		expect(closed).not.toHaveBeenCalled();
		panel.close(closed);
		vi.advanceTimersByTime(584);
		expect(closed).toHaveBeenCalledOnce();
		panel.dispose();
		input.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps the draft intact when an editor viewport grows and shrinks", () => {
		const { editor: input } = editor();
		const draft = Array.from({ length: 25 }, (_, i) => `Line ${i + 1} 中文`).join("\n");
		input.setText(draft);
		const cursor = input.getCursor();
		input.setViewportLines(18);
		expect(input.render(80)).toHaveLength(20);
		input.setViewportLines(6);
		expect(input.render(80)).toHaveLength(8);
		expect(input.getText()).toBe(draft);
		expect(input.getCursor()).toEqual(cursor);
		input.dispose();
	});
});
