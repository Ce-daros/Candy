import { Container, type TUI } from "@candy/tui";
import { describe, expect, it, vi } from "vitest";
import { ExtensionWidgetAdapter } from "../src/modes/interactive/extension-widget-adapter.ts";

describe("ExtensionWidgetAdapter", () => {
	it("owns placement, replacement, and disposal of extension widgets", () => {
		const requestRender = vi.fn();
		const adapter = new ExtensionWidgetAdapter({ requestRender } as unknown as TUI);
		const dispose = vi.fn();
		const previous = Object.assign(new Container(), { dispose });
		const next = new Container();

		adapter.set("status", () => previous);
		adapter.set("status", () => next, { placement: "belowEditor" });

		expect(dispose).toHaveBeenCalledOnce();
		expect(adapter.above.children).not.toContain(previous);
		expect(adapter.below.children).toContain(next);

		adapter.clear();

		expect(adapter.below.children).toHaveLength(0);
		expect(requestRender).toHaveBeenCalledTimes(3);
	});
});
