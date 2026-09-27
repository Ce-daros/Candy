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
});
