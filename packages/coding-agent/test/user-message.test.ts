import type { TuiMouseEvent } from "@candy/tui";
import { describe, expect, test, vi } from "vitest";

const clipboardMocks = vi.hoisted(() => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/utils/clipboard.ts", () => clipboardMocks);

import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
describe("UserMessageComponent", () => {
	test("uses a pink diamond, transparent rows and OSC markers around the message", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(stripAnsi(lines[0])).toContain("◆ hello");
		expect(lines[0]).toContain(OSC133_ZONE_END + OSC133_ZONE_FINAL);
		expect(lines[0]).not.toContain("\x1b[49m");
	});

	test("folds after eight wrapped screen rows and expands inline", () => {
		initTheme("dark");
		const component = new UserMessageComponent(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"));
		const collapsed = component.render(30).map(stripAnsi);
		expect(collapsed).toHaveLength(9);
		expect(collapsed.join("\n")).not.toContain("line 11");
		component.setExpanded(true);
		expect(component.render(30).map(stripAnsi).join("\n")).toContain("line 11");
	});

	test("routes visible code Copy through the user message gutter", () => {
		initTheme("dark");
		const component = new UserMessageComponent("```ts\nconst candy = true;\n```");
		const lines = component.render(80);
		expect(stripAnsi(lines[0])).toContain("Copy");
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 78,
			y: 0,
			screenX: 78,
			screenY: 0,
			width: 80,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
		};
		expect(component.handleMouse(event)?.handled).toBe(true);
		expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("const candy = true;");
	});
});
