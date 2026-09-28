import type { TuiMouseEvent } from "@candy/tui";
import { describe, expect, test, vi } from "vitest";
import { TranscriptNotice } from "../src/modes/interactive/components/transcript-notice.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function click(y: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 1,
		y,
		screenX: 1,
		screenY: y,
		width: 24,
		height: 10,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
}

describe("TranscriptNotice", () => {
	test("renders semantic markers and collapses long bodies to four lines", () => {
		initTheme("dark");
		const notice = new TranscriptNotice({
			tone: "error",
			title: "Authentication failed",
			body: "word ".repeat(30),
		});
		const collapsed = notice.render(24).map(stripAnsi);
		expect(collapsed[0]).toContain("× Authentication failed");
		expect(collapsed.filter((line) => line.includes("│")).length).toBe(5);
		notice.setExpanded(true);
		expect(notice.render(24).map(stripAnsi).join("\n").match(/word/g)).toHaveLength(30);
	});

	test("opens linked notices from the title and expands from the body", () => {
		initTheme("dark");
		const onOpen = vi.fn();
		const notice = new TranscriptNotice({ tone: "warning", title: "Update available", body: "Details", onOpen });
		notice.render(40);
		expect(notice.handleMouse(click(0))?.handled).toBe(true);
		expect(onOpen).toHaveBeenCalledOnce();
		expect(notice.handleMouse(click(1))?.handled).toBe(true);
		expect(notice.render(40)).toHaveLength(2);
	});
});
