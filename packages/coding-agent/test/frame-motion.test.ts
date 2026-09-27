import type { TUI } from "@candy/tui";
import { visibleWidth } from "@candy/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { FrameMotion } from "../src/modes/interactive/components/frame-motion.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("editor frame motion", () => {
	let motion: FrameMotion;

	beforeEach(() => {
		vi.useFakeTimers();
		initTheme(undefined, false);
		motion = new FrameMotion({ requestRender: () => {} } as TUI);
		motion.setGeometry(60, 4, 4, 30);
	});

	afterEach(() => {
		motion.dispose();
		vi.useRealTimers();
	});

	it("reveals the whole frame from the selector anchors without changing width", () => {
		const top = `╭${"─".repeat(58)}╮`;
		motion.beginFrame();
		const initial = stripAnsi(motion.paintBorder(top, 0, 0));
		expect(visibleWidth(initial)).toBe(60);
		expect(initial).toContain(" ");
		vi.advanceTimersByTime(520);
		expect(stripAnsi(motion.paintBorder(top, 0, 0))).toBe(top);
	});

	it("starts its entrance clock on the first frame and renders intermediate growth", () => {
		const top = `╭${"─".repeat(58)}╮`;
		vi.advanceTimersByTime(1000);
		motion.beginFrame();
		const frames = new Set<string>();
		for (let elapsed = 0; elapsed <= 520; elapsed += 24) {
			frames.add(stripAnsi(motion.paintBorder(top, 0, 0)));
			vi.advanceTimersByTime(24);
		}
		expect(frames.size).toBeGreaterThan(12);
		expect([...frames].at(-1)).toBe(top);
	});

	it("changes border color without changing the visible frame", () => {
		motion.beginFrame();
		vi.advanceTimersByTime(520);
		motion.setMode("shell");
		vi.advanceTimersByTime(360);
		const shell = motion.paintBorder("────", 7, 0);
		expect(shell).toContain("\x1b[38;");
		expect(stripAnsi(shell)).toBe("────");
		motion.setMode("shell-no-context");
		expect(motion.paintBorder("─", 7, 0)).toContain("\x1b[38;");
	});

	it("blends cyan into yellow over multiple Shell frames", () => {
		motion.beginFrame();
		vi.advanceTimersByTime(520);
		motion.setMode("shell");
		const colors = new Set<string>();
		for (let elapsed = 0; elapsed <= 360; elapsed += 24) {
			colors.add(motion.paintBorder("─", 8, 0));
			vi.advanceTimersByTime(24);
		}
		expect(colors.size).toBeGreaterThan(4);
	});

	it("keeps the current border color when a Shell sweep reverses", () => {
		motion.beginFrame();
		vi.advanceTimersByTime(520);
		motion.setMode("shell");
		vi.advanceTimersByTime(120);
		const before = motion.paintBorder("─", 8, 0);
		motion.setMode("normal");
		expect(motion.paintBorder("─", 8, 0)).toBe(before);
		vi.advanceTimersByTime(360);
		expect(motion.paintBorder("─", 8, 0)).not.toBe(before);
	});

	it("keeps activity trails visible on the yellow Shell frame in the light theme", () => {
		initTheme("light", false);
		motion.beginFrame();
		vi.advanceTimersByTime(520);
		motion.setMode("shell");
		vi.advanceTimersByTime(360);
		motion.setThinking("high");
		motion.setStatus("working");
		const first = motion.paintBorder("─".repeat(60), 0, 0);
		vi.advanceTimersByTime(90);
		const second = motion.paintBorder("─".repeat(60), 0, 0);
		expect(first).not.toBe(second);
		expect(stripAnsi(first)).toBe("─".repeat(60));
	});

	it("keeps the Shell title during the exit sweep", () => {
		motion.beginFrame();
		vi.advanceTimersByTime(520);
		motion.setMode("shell");
		vi.advanceTimersByTime(360);
		motion.setMode("normal");
		expect(motion.getShellTitle()).toBe("Shell");
		vi.advanceTimersByTime(360);
		expect(motion.getShellTitle()).toBe("");
	});

	it("shows the finished border immediately when animation is disabled", () => {
		motion.beginFrame();
		motion.setMode("shell");
		vi.advanceTimersByTime(48);
		motion.setOptions(false, "moderate");
		expect(stripAnsi(motion.paintBorder("╭───╮", 0, 0))).toBe("╭───╮");
		expect(motion.getLabelPhase()).toBe(8);
	});

	it("renders the Shell title with one space of padding on each side", () => {
		const tui = { requestRender: () => {}, terminal: { rows: 20 } } as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create());
		editor.setAnimationOptions(false, "moderate");
		expect(stripAnsi(editor.render(40)[0]!)).toBe(`╭${"─".repeat(38)}╮`);
		editor.setShellMode("shell");
		expect(stripAnsi(editor.render(40)[0]!)).toContain(" Shell ");
		editor.setShellMode("shell-no-context");
		expect(stripAnsi(editor.render(40)[0]!)).toContain(" Shell · No Context ");
		editor.dispose();
	});

	it("renders the prompt glyph per input mode with its own color", () => {
		const tui = { requestRender: () => {}, terminal: { rows: 20 } } as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create());
		editor.setAnimationOptions(false, "moderate");

		const normal = editor.render(40);
		expect(stripAnsi(normal[1]!)).toMatch(/^│ ◆ /);
		expect(normal[1]!).toContain(theme.getFgAnsi("editorPrompt"));

		editor.setShellMode("shell");
		const shell = editor.render(40);
		expect(stripAnsi(shell[1]!)).toMatch(/^│ ❯ /);
		expect(shell[1]!).toContain(theme.getFgAnsi("bashMode"));
		editor.dispose();
	});

	it("renders the typed text in the text color", () => {
		const tui = { requestRender: () => {}, terminal: { rows: 20 } } as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create());
		editor.setAnimationOptions(false, "moderate");
		editor.setText("hello");
		expect(editor.render(40)[1]!).toContain(theme.getFgAnsi("text"));
		editor.dispose();
	});

	it("keeps narrow editor rows aligned throughout the entrance and Shell transition", () => {
		const tui = { requestRender: () => {}, terminal: { rows: 20 } } as TUI;
		const session = {
			state: { model: { id: "kimi", name: "Kimi K2.6", reasoning: true }, thinkingLevel: "medium" },
		} as AgentSession;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create());
		editor.setBottomStatus(new FooterComponent(session));
		for (const width of [18, 24, 40]) {
			for (let elapsed = 0; elapsed < 520; elapsed += 48) {
				expect(editor.render(width).every((line) => visibleWidth(line) === width)).toBe(true);
				vi.advanceTimersByTime(48);
			}
			editor.setShellMode("shell");
			for (let elapsed = 0; elapsed < 360; elapsed += 48) {
				expect(editor.render(width).every((line) => visibleWidth(line) === width)).toBe(true);
				vi.advanceTimersByTime(48);
			}
		}
		editor.dispose();
	});
});
