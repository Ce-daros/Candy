import { setKeybindings, TuiMainScreen } from "@candy/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { BorderedLoader } from "../src/modes/interactive/components/bordered-loader.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { KeybindingsManager } from "../src/presentation/keybindings.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));
beforeEach(() => {
	vi.useFakeTimers();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => vi.useRealTimers());

describe("BorderedLoader", () => {
	it.each([true, false])("keeps a stable signal and stops animation on dispose when cancellable=%s", (cancellable) => {
		const tui = new TuiMainScreen(new VirtualTerminal());
		const render = vi.spyOn(tui, "requestRender");
		const loader = new BorderedLoader(tui, theme, "Working", { cancellable });
		const signal = loader.signal;
		expect(loader.signal).toBe(signal);
		expect(stripAnsi(loader.render(80).join("\n"))).toContain("Working");
		vi.advanceTimersByTime(160);
		expect(render.mock.calls.length).toBeGreaterThan(1);
		loader.dispose();
		render.mockClear();
		vi.advanceTimersByTime(160);
		expect(render).not.toHaveBeenCalled();
		expect(loader.signal).toBe(signal);
	});

	it("shows the cancel hint and aborts before the default cancellation callback", () => {
		const loader = new BorderedLoader(new TuiMainScreen(new VirtualTerminal()), theme, "Working");
		const aborted = vi.fn(() => expect(loader.signal.aborted).toBe(true));
		loader.onAbort = aborted;
		expect(stripAnsi(loader.render(80).join("\n"))).toContain("cancel");
		loader.handleInput("\x1b");
		expect(aborted).toHaveBeenCalledOnce();
		loader.dispose();
	});

	it("ignores Escape and omits the cancel hint when cancellation is disabled", () => {
		const loader = new BorderedLoader(new TuiMainScreen(new VirtualTerminal()), theme, "Working", {
			cancellable: false,
		});
		const aborted = vi.fn();
		loader.onAbort = aborted;
		loader.handleInput("\x1b");
		expect(loader.signal.aborted).toBe(false);
		expect(aborted).not.toHaveBeenCalled();
		expect(stripAnsi(loader.render(80).join("\n"))).not.toContain("cancel");
		loader.dispose();
	});
});
