import type { TUI } from "@candy/tui";
import { setCapabilityOverrides, visibleWidth } from "@candy/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { FrameMotion } from "../src/modes/interactive/components/frame-motion.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { KeybindingsManager } from "../src/presentation/keybindings.ts";
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
		setCapabilityOverrides({});
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

	it.each([true, false])("keeps distinct static thinking gradients with trueColor=%s", (trueColor) => {
		setCapabilityOverrides({ trueColor });
		initTheme("dark", false);
		motion.setOptions(false, "moderate");
		const frames = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => {
			motion.setThinking(level as Parameters<FrameMotion["setThinking"]>[0]);
			return motion.paintBorder("─".repeat(60), 0, 0);
		});
		expect(new Set(frames).size).toBe(7);
		expect(frames[5]).toContain(trueColor ? "\x1b[38;2;" : "\x1b[38;5;");
		expect(new Set(frames[5]!.match(/\x1b\[38;[^m]+m/g)).size).toBeGreaterThan(trueColor ? 8 : 1);
		const staticFrame = frames[6];
		vi.advanceTimersByTime(4000);
		expect(motion.paintBorder("─".repeat(60), 0, 0)).toBe(staticFrame);
	});

	it("continues breathing while idle and clears the animation timer on disposal", () => {
		motion.beginFrame();
		motion.setThinking("max");
		vi.advanceTimersByTime(1000);
		const before = motion.paintBorder("─".repeat(60), 0, 0);
		vi.advanceTimersByTime(1300);
		expect(motion.paintBorder("─".repeat(60), 0, 0)).not.toBe(before);
		motion.dispose();
		expect(vi.getTimerCount()).toBe(0);
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

	it("sweeps into Command and reverses from its current border color", () => {
		motion.beginFrame();
		vi.advanceTimersByTime(520);
		motion.setMode("command");
		expect(motion.getModeTitle()).toBe("Command");
		vi.advanceTimersByTime(120);
		const before = motion.paintBorder("─", 8, 0);
		motion.setMode("normal");
		expect(motion.paintBorder("─", 8, 0)).toBe(before);
		vi.advanceTimersByTime(360);
		expect(motion.getModeTitle()).toBe("");
	});

	it("uses the Command accent when animation is disabled", () => {
		motion.setOptions(false, "moderate");
		motion.setMode("command");
		expect(motion.paintBorder("─", 8, 0)).toContain(theme.getFgAnsi("accent"));
		expect(motion.getModeTitle()).toBe("Command");
	});

	it("sweeps the Help frame into cyan and reverses from the current color", () => {
		motion.beginFrame();
		vi.advanceTimersByTime(520);
		motion.setMode("help");
		vi.advanceTimersByTime(120);
		const before = motion.paintBorder("─", 8, 0);
		motion.setMode("normal");
		expect(motion.paintBorder("─", 8, 0)).toBe(before);
		vi.advanceTimersByTime(360);
		motion.setOptions(false, "moderate");
		motion.setMode("help");
		expect(motion.paintBorder("─", 8, 0)).toContain(theme.getFgAnsi("borderAccent"));
		expect(motion.getModeTitle()).toBe("Help");
	});

	it("releases a Command transition timer on disposal", () => {
		motion.beginFrame();
		motion.setMode("command");
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		motion.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("preserves styled keycaps and display width while a title retracts", () => {
		const keycap = theme.fg("borderAccent", "<Escape>");
		const title = `${keycap} 中文`;
		motion.setMode("command");
		vi.advanceTimersByTime(360);
		expect(motion.paintTitle(title)).toContain(keycap);
		motion.setMode("normal");
		for (let elapsed = 0; elapsed <= 360; elapsed += 24) {
			expect(visibleWidth(motion.paintTitle(title))).toBe(visibleWidth(title));
			vi.advanceTimersByTime(24);
		}
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
		expect(motion.getModeTitle()).toBe("Shell");
		vi.advanceTimersByTime(360);
		expect(motion.getModeTitle()).toBe("");
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
		editor.setInputMode("shell");
		expect(stripAnsi(editor.render(40)[0]!)).toContain(" Shell ");
		editor.setInputMode("shell-no-context");
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

		editor.setInputMode("shell");
		const shell = editor.render(40);
		expect(stripAnsi(shell[1]!)).toMatch(/^│ ❯ /);
		expect(shell[1]!).toContain(theme.getFgAnsi("bashMode"));

		editor.setInputMode("command");
		const command = editor.render(40);
		expect(stripAnsi(command[0]!)).toContain(" Command ");
		expect(stripAnsi(command[1]!)).toMatch(/^│ \/ /);
		expect(command[1]!).toContain(theme.getFgAnsi("accent"));

		editor.setInputMode("help");
		const help = editor.render(40);
		expect(stripAnsi(help[0]!)).toContain(" Help ");
		expect(stripAnsi(help[1]!)).toMatch(/^│ \? /);
		expect(help[1]!).toContain(theme.getFgAnsi("borderAccent"));
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
			selection: { model: { id: "kimi", name: "Kimi K2.6", reasoning: true }, thinkingLevel: "medium" },
		} as AgentSession;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create());
		editor.setBottomStatus(new FooterComponent(session));
		for (const width of [18, 24, 40]) {
			for (let elapsed = 0; elapsed < 520; elapsed += 48) {
				expect(editor.render(width).every((line) => visibleWidth(line) === width)).toBe(true);
				vi.advanceTimersByTime(48);
			}
			editor.setInputMode("shell");
			for (let elapsed = 0; elapsed < 360; elapsed += 48) {
				expect(editor.render(width).every((line) => visibleWidth(line) === width)).toBe(true);
				vi.advanceTimersByTime(48);
			}
		}
		editor.dispose();
	});
});
