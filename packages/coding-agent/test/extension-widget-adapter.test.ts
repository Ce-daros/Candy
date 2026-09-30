import type { TUI } from "@candy/tui";
import { describe, expect, it, vi } from "vitest";
import { ExtensionWidgetAdapter } from "../src/modes/interactive/extension-widget-adapter.ts";

describe("ExtensionWidgetAdapter", () => {
	it("renders text widgets in registration order and removes cleared entries", () => {
		const requestRender = vi.fn();
		const adapter = new ExtensionWidgetAdapter({ requestRender } as unknown as TUI);

		adapter.set("status", ["ready", "working"]);
		adapter.set("notice", ["connected"]);

		expect(adapter.above.render(40)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("ready"),
				expect.stringContaining("working"),
				expect.stringContaining("connected"),
			]),
		);
		expect(requestRender).toHaveBeenCalledTimes(2);

		adapter.set("status", undefined);
		expect(adapter.above.render(40).join("\n")).not.toContain("ready");

		adapter.clear();

		expect(adapter.above.render(40).join("\n")).not.toContain("connected");
		expect(requestRender).toHaveBeenCalledTimes(4);
	});
});
