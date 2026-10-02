import { type Component, CURSOR_MARKER, isFocusable, type TUI } from "@candy/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountStartupContent } from "../src/cli/startup-ui.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function startup(animations: boolean) {
	let surface!: Component;
	const page = {
		focused: false,
		invalidate: vi.fn(),
		render: vi.fn(() => [`Session${CURSOR_MARKER}`, "first", "second"]),
		handleMouse: vi.fn(() => ({ handled: true })),
	};
	const ui = {
		terminal: { rows: 24 },
		requestRender: vi.fn(),
		addChild: (child: Component) => {
			surface = child;
		},
		setFocus: (target: Component | null) => {
			page.focused = target !== null && isFocusable(target);
		},
	} as unknown as TUI;
	const close = mountStartupContent(ui, SettingsManager.inMemory({ uiAnimations: animations }), page);
	return { surface, page, close };
}

describe("startup motion", () => {
	it("updates stages inside the open page immediately without restarting its entrance", () => {
		const { surface, page } = startup(true);
		surface.render(80);
		vi.advanceTimersByTime(816);
		surface.render(80);
		page.render.mockImplementation(() => ["Waiting", "Checking credentials…"]);
		expect(surface.render(80)).toEqual(["Waiting", "Checking credentials…"]);
		expect(page.focused).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("opens and closes immediately when animations are disabled", async () => {
		const { surface, page, close } = startup(false);
		expect(surface.render(80).join("\n")).toContain("Session");
		expect(page.focused).toBe(true);
		await close();
		expect(page.focused).toBe(false);
		expect(surface.render(80)).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps an outgoing snapshot and stops rendering the closed component", async () => {
		const { surface, page, close } = startup(true);
		surface.render(80);
		vi.advanceTimersByTime(816);
		surface.render(80);
		const pending = close();
		page.render.mockImplementation(() => {
			throw new Error("disposed");
		});
		expect(surface.render(80).join("\n")).not.toContain(CURSOR_MARKER);
		vi.advanceTimersByTime(816);
		await pending;
		expect(surface.render(80)).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("finishes cancellation before the first frame without starting an entrance", async () => {
		const { surface, close } = startup(true);
		const pending = close();
		surface.render(80);
		vi.advanceTimersByTime(816);
		await pending;
		expect(surface.render(80)).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
