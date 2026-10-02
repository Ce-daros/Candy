import { setCapabilityOverrides, setKeybindings, type TUI, visibleWidth } from "@candy/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { keycap, keyText } from "../src/modes/interactive/components/keybinding-hints.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	IdleStatus,
	RetryStatusIndicator,
	WorkingStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { KeybindingsManager } from "../src/presentation/keybindings.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("status indicators", () => {
	beforeEach(() => {
		setKeybindings(KeybindingsManager.create());
		setCapabilityOverrides({ trueColor: true });
	});

	afterEach(() => {
		setCapabilityOverrides({});
		vi.useRealTimers();
	});

	it("keeps idle status at the same height as standalone status indicators", () => {
		const idleStatus = new IdleStatus();

		const lines = idleStatus.render(20);
		expect(lines).toHaveLength(2);
		expect(lines).toEqual([" ".repeat(20), " ".repeat(20)]);
	});

	it("keeps the top border unchanged unless the editor opts in", () => {
		initTheme("dark");
		const tui = {
			requestRender: vi.fn(),
			terminal: { rows: 10 },
		} as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create());
		editor.setAnimationOptions(false, "moderate");
		const indicator = new WorkingStatusIndicator(tui, "Working");
		editor.setWorkingStatusIndicator(indicator);

		const lines = editor.render(20);
		expect(stripAnsi(lines[0]!)).toBe(`╭${"─".repeat(18)}╮`);
		expect(lines).toHaveLength(4);
		expect(stripAnsi(lines[1]!)).toMatch(/^│ ◆ /);
		expect(stripAnsi(lines[1]!)).toMatch(/│$/);
		expect(stripAnsi(lines[2]!)).toBe(`│${" ".repeat(18)}│`);
		expect(lines.every((line) => visibleWidth(line) === 20)).toBe(true);
		const standaloneLine = indicator.render(20)[1]!;
		expect(standaloneLine).toContain(theme.getFgAnsi("accent"));
		expect(standaloneLine).toContain(theme.getFgAnsi("muted"));
		indicator.dispose();
		editor.dispose();
	});

	it("keeps wrapped input and narrow frames within terminal width", () => {
		initTheme("dark");
		const tui = { requestRender: vi.fn(), terminal: { rows: 20 } } as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create());
		editor.setAnimationOptions(false, "moderate");
		editor.setText("a".repeat(50));
		for (const width of [3, 4, 8, 20]) {
			const lines = editor.render(width);
			expect(
				lines.every((line) => visibleWidth(line) === width),
				`width ${width}`,
			).toBe(true);
			if (width >= 5) expect(stripAnsi(lines[1]!)).toMatch(/│$/);
		}
		editor.dispose();
	});

	it("embeds the working indicator when the editor opts in", () => {
		initTheme("dark");
		const tui = {
			requestRender: vi.fn(),
			terminal: { rows: 10 },
		} as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
		});
		expect(editor.embedWorkingStatus).toBe(true);
		editor.setAnimationOptions(false, "moderate");
		const indicator = new WorkingStatusIndicator(tui, "Working");
		editor.setWorkingStatusIndicator(indicator);

		const topBorder = editor.render(20)[0]!;
		expect(stripAnsi(topBorder)).toBe("╭────── Working ───╮");
		expect(visibleWidth(topBorder)).toBe(20);
		expect(topBorder).toContain(theme.getFgAnsi("border"));
		indicator.dispose();
		editor.dispose();
	});

	it("renders moving true-color thinking trails on the editor frame", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender, terminal: { rows: 20 } } as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
		});
		const indicator = new WorkingStatusIndicator(tui, "Working");
		try {
			editor.render(80);
			vi.advanceTimersByTime(520);
			editor.setThinkingLevel("medium");
			editor.setWorkingStatusIndicator(indicator);
			const frames = new Set<string>();
			const colors = new Set<string>();
			const callsBeforeMotion = requestRender.mock.calls.length;
			for (let elapsed = 0; elapsed < 900; elapsed += 90) {
				const lines = editor.render(80);
				const border = lines.join("\n");
				frames.add(border);
				for (const ansi of border.match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? []) colors.add(ansi);
				expect(stripAnsi(lines[0])).not.toContain("Working");
				vi.advanceTimersByTime(90);
			}
			expect(frames.size).toBeGreaterThan(6);
			expect(colors.size).toBeGreaterThanOrEqual(8);
			expect(requestRender.mock.calls.length - callsBeforeMotion).toBeGreaterThanOrEqual(9);
			editor.setThinkingLevel("minimal");
			const minimal = editor.render(80)[0];
			editor.setThinkingLevel("max");
			expect(editor.render(80)[0]).not.toBe(minimal);

			editor.setAnimationOptions(false, "moderate");
			const still = editor.render(80)[0];
			const callsAfterDisable = requestRender.mock.calls.length;
			vi.advanceTimersByTime(900);
			expect(editor.render(80)[0]).toBe(still);
			expect(requestRender).toHaveBeenCalledTimes(callsAfterDisable);
		} finally {
			indicator.dispose();
			editor.dispose();
		}
	});

	it.each(["retry", "compaction", "branchSummary"] as const)("animates the %s frame track", (kind) => {
		initTheme("dark");
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn(), terminal: { rows: 20 } } as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
		});
		const indicator =
			kind === "retry"
				? new RetryStatusIndicator(tui, 1, 3, 3000)
				: kind === "compaction"
					? new CompactionStatusIndicator(tui, "manual")
					: new BranchSummaryStatusIndicator(tui);
		try {
			editor.render(80);
			vi.advanceTimersByTime(520);
			editor.setWorkingStatusIndicator(indicator);
			const frames = new Set<string>();
			for (let index = 0; index < 24; index++) {
				frames.add(editor.render(80).join("\n"));
				vi.advanceTimersByTime(90);
			}
			expect(frames.size).toBeGreaterThan(3);
		} finally {
			indicator.dispose();
			editor.dispose();
		}
	});

	it("embeds compaction, summary, and retry labels within the border width", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
		});
		const indicators = [
			new CompactionStatusIndicator(tui, "manual"),
			new CompactionStatusIndicator(tui, "threshold"),
			new CompactionStatusIndicator(tui, "overflow"),
			new BranchSummaryStatusIndicator(tui),
			new RetryStatusIndicator(tui, 1, 3, 3000),
		];
		try {
			for (const indicator of indicators) {
				editor.setWorkingStatusIndicator(indicator);
				const line = editor.render(120)[0]!;
				expect(stripAnsi(line)).toMatch(/Retrying|[Cc]ompacting|Summarizing/);
				expect(line).toContain(keycap(keyText("app.interrupt")));
				for (const width of [1, 4, 10, 20, 80, 120]) {
					expect(visibleWidth(editor.render(width)[0]!)).toBe(width);
				}
			}
			editor.setAnimationOptions(false, "moderate");
			expect(stripAnsi(editor.render(120)[0]!)).toContain("Retrying");
			expect(stripAnsi(editor.render(120)[0]!)).toContain(stripAnsi(keycap(keyText("app.interrupt"))));
			vi.advanceTimersByTime(1000);
			expect(stripAnsi(editor.render(120)[0]!)).toContain("(1/3) in 2s");
			editor.setWorkingStatusIndicator(undefined);
			expect(stripAnsi(editor.render(120)[0]!)).toBe(`╭${"─".repeat(118)}╮`);
		} finally {
			for (const indicator of indicators) indicator.dispose();
			editor.dispose();
		}
	});

	it("disposes retry countdown updates", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const callsBeforeDispose = requestRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(2000);

		expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});
});
