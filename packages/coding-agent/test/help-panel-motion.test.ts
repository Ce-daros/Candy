import type { TUI, TuiMouseEvent } from "@candy/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelpPanel } from "../src/modes/interactive/components/help-panel.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeEach(() => {
	vi.useFakeTimers();
	initTheme("dark", false);
});
afterEach(() => vi.useRealTimers());

describe("help panel motion", () => {
	it("maps a visible clipped entrance row to the correct item and rejects closing clicks", () => {
		const select = vi.fn();
		const panel = new HelpPanel({ requestRender: vi.fn() } as unknown as TUI, () => "", select);
		panel.open();
		vi.advanceTimersByTime(360);
		const lines = panel.render(80);
		const row = lines.findIndex((line) => line.includes("Changelog"));
		expect(row).toBeGreaterThanOrEqual(0);
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 4,
			y: row,
			width: 80,
			height: lines.length,
			screenX: 4,
			screenY: row,
			shift: false,
			alt: false,
			ctrl: false,
		};
		panel.handleMouse(event);
		expect(select).toHaveBeenCalledWith("changelog");
		select.mockClear();
		panel.close(vi.fn());
		panel.handleMouse(event);
		expect(select).not.toHaveBeenCalled();
		panel.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
});
