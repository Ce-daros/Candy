import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("InteractiveMode thinking level cycling", () => {
	it("applies the cycled level and reports it", () => {
		initTheme("dark");
		const context = {
			session: { selection: { cycleThinkingLevel: vi.fn(() => "high") } },
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
		};
		const cycle = Reflect.get(InteractiveMode.prototype, "cycleThinkingLevel") as (this: typeof context) => void;

		cycle.call(context);

		expect(context.session.selection.cycleThinkingLevel).toHaveBeenCalledOnce();
		expect(context.updateEditorBorderColor).toHaveBeenCalledOnce();
		expect(context.showStatus).toHaveBeenCalledWith("Thinking level: high");
	});

	it("reports models without thinking support without refreshing the frame", () => {
		initTheme("dark");
		const context = {
			session: { selection: { cycleThinkingLevel: vi.fn(() => undefined) } },
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
		};
		const cycle = Reflect.get(InteractiveMode.prototype, "cycleThinkingLevel") as (this: typeof context) => void;

		cycle.call(context);

		expect(context.showStatus).toHaveBeenCalledWith("Current model does not support thinking");
		expect(context.footer.invalidate).not.toHaveBeenCalled();
		expect(context.updateEditorBorderColor).not.toHaveBeenCalled();
	});
});
