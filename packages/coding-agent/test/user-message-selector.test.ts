import type { TuiMouseEvent } from "@candy/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("UserMessageSelectorComponent", () => {
	beforeAll(() => initTheme("dark"));

	it("shows two-line summaries with a full scrolling preview", () => {
		const select = vi.fn();
		const selector = new UserMessageSelectorComponent(
			[
				{ id: "one", text: "First message" },
				{ id: "two", text: "Second message with more detail" },
			],
			select,
			vi.fn(),
			"one",
		);
		selector.setAvailableHeight(16);
		let output = stripAnsi(selector.render(80).join("\n"));
		expect(output).toContain("First message");
		expect(output).toContain("Second message");
		selector.handleMouse({ type: "click", button: "left", y: 4 } as TuiMouseEvent);
		output = stripAnsi(selector.render(80).join("\n"));
		expect(output).toContain("Message 2 of 2");
		selector.handleInput("\r");
		expect(select).toHaveBeenCalledWith("two");
	});

	it("resets the preview when the mouse wheel changes the selected message", () => {
		const firstMessage = Array.from({ length: 30 }, (_, index) => `first-${index}`).join("\n");
		const selector = new UserMessageSelectorComponent(
			[
				{ id: "first", text: firstMessage },
				{ id: "second", text: "second message" },
			],
			vi.fn(),
			vi.fn(),
			"second",
		);
		selector.setAvailableHeight(20);
		selector.handleInput("\t");
		for (let index = 0; index < 20; index++) selector.handleInput("\x1b[B");
		selector.handleInput("\t");
		selector.handleMouse({ type: "wheel", wheelDelta: 1 } as TuiMouseEvent);

		expect(stripAnsi(selector.render(80).join("\n"))).toContain("first-0");
	});
});
