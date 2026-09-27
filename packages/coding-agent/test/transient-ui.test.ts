import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueuedMessagesComponent } from "../src/modes/interactive/components/queued-messages.ts";
import { TransientNotification } from "../src/modes/interactive/components/transient-notification.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeEach(() => initTheme("dark", false));
afterEach(() => vi.useRealTimers());

describe("transient UI", () => {
	it("replaces a short notification and expires it without leaving a timer", () => {
		vi.useFakeTimers();
		const notice = new TransientNotification(
			() => {},
			() => true,
		);
		notice.show("First");
		vi.advanceTimersByTime(2900);
		notice.show("Second");
		vi.advanceTimersByTime(600);
		expect(notice.render(80).map(stripAnsi).join("")).toContain("Second");
		vi.advanceTimersByTime(2800);
		expect(notice.render(80)).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("shows three queue previews, then reveals every message on expansion", () => {
		const queue = new QueuedMessagesComponent(["one", "two"], ["three", "four\nfive"], "Alt+Up");
		const compact = queue.render(40).map(stripAnsi).join("\n");
		expect(compact).toContain("Queued 4");
		expect(compact).toContain("Steering  one");
		expect(compact).toContain("Follow-up  three");
		expect(compact).not.toContain("four");
		queue.setExpanded(true);
		const expanded = queue.render(40).map(stripAnsi).join("\n");
		expect(expanded).toContain("four\nfive");
		expect(expanded).toContain("Alt+Up to edit all");
	});
});
