import { type TuiMouseEvent, visibleWidth } from "@candy/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { keycap } from "../src/modes/interactive/components/keybinding-hints.ts";
import { ReadingPanelComponent } from "../src/modes/interactive/components/reading-panel.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const clipboardCopy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../src/utils/clipboard.ts", () => ({ copyToClipboard: clipboardCopy }));

describe("ReadingPanelComponent", () => {
	beforeAll(() => initTheme("dark"));
	it("scrolls long markdown within the available height", () => {
		const panel = new ReadingPanelComponent(
			"What's New",
			Array.from({ length: 30 }, (_, i) => `Paragraph ${i}`).join("\n\n"),
			vi.fn(),
		);
		panel.setAvailableHeight(8);
		const first = stripAnsi(panel.render(80).join("\n"));
		expect(first).toContain("Paragraph 0");
		expect(first).not.toContain("Paragraph 29");
		panel.handleInput("\x1b[6~");
		const later = stripAnsi(panel.render(80).join("\n"));
		expect(later).not.toContain("Paragraph 0");
	});

	it("groups and searches hotkeys by action, key, and category", () => {
		const panel = new ReadingPanelComponent("Hotkeys", "", vi.fn(), [
			{ category: "Navigation", label: "Next panel", value: "Tab" },
			{ category: "Navigation", label: "Previous panel", value: "Shift+Tab" },
			{ category: "Sessions", label: "Resume session", value: "Ctrl+R" },
		]);
		panel.setAvailableHeight(10);
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("Navigation");
		panel.handleInput("s");
		panel.handleInput("e");
		panel.handleInput("s");
		const filtered = stripAnsi(panel.render(80).join("\n"));
		expect(filtered).toContain("Resume session");
		expect(filtered).not.toContain("Next panel");
	});

	it("closes with Esc", () => {
		const onClose = vi.fn();
		const panel = new ReadingPanelComponent("Session", "Details", onClose);
		panel.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("shows complete keycap alternatives at 80 terminal columns and searches visible text", () => {
		const value = keycap("shift+enter/ctrl+shift+g");
		const panel = new ReadingPanelComponent("Hotkeys", "", vi.fn(), [
			{ category: "Conversation", label: "Select the previous search match", value },
		]);
		const lines = panel.render(76);
		expect(lines.some((line) => line.includes(value))).toBe(true);
		expect(lines.every((line) => visibleWidth(line) <= 76)).toBe(true);
		panel.handleInput("38;");
		expect(stripAnsi(panel.render(76).join("\n"))).toContain("No matching actions");
	});

	it("copies original code from a scrolled Markdown header", () => {
		clipboardCopy.mockClear();
		const code = "const candy = 'sweet';\nconsole.log(candy);";
		const panel = new ReadingPanelComponent(
			"Changelog",
			`${Array.from({ length: 8 }, (_, index) => `Paragraph ${index}`).join("\n\n")}\n\n\`\`\`ts\n${code}\n\`\`\``,
			vi.fn(),
		);
		panel.setAvailableHeight(8);
		let lines = stripAnsi(panel.render(80).join("\n")).split("\n");
		for (let index = 0; index < 20 && !lines.some((line) => line.includes("Copy")); index++) {
			panel.handleInput("\x1b[6~");
			lines = stripAnsi(panel.render(80).join("\n")).split("\n");
		}
		const headerRow = lines.findIndex((line) => line.includes("Copy"));
		expect(headerRow).toBeGreaterThanOrEqual(2);
		const event = (y: number): TuiMouseEvent => ({
			type: "click",
			button: "left",
			x: 78,
			y,
			screenX: 78,
			screenY: y,
			width: 80,
			height: 8,
			shift: false,
			alt: false,
			ctrl: false,
		});
		panel.handleMouse(event(headerRow));
		expect(clipboardCopy).toHaveBeenCalledWith(code);
		panel.handleMouse(event(0));
		expect(clipboardCopy).toHaveBeenCalledOnce();
	});
});
