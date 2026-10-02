import type { Component } from "@candy/tui";
import { describe, expect, it } from "vitest";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";
import { ansiLinesToHtml } from "../src/presentation/export-html/ansi-to-html.ts";
import { createToolHtmlRenderer } from "../src/presentation/export-html/tool-renderer.ts";
import type { ToolRenderers } from "../src/presentation/tool-render-types.ts";

describe("export HTML tool output whitespace", () => {
	it("does not insert source whitespace between ANSI-rendered lines", () => {
		expect(ansiLinesToHtml(["one", "two"])).toBe('<div class="ansi-line">one</div><div class="ansi-line">two</div>');
	});

	it("trims TUI spacing lines from custom tool result HTML", () => {
		const component: Component = { render: () => ["", "\u001b[31mone\u001b[0m", "two", ""], invalidate: () => {} };
		const tool = {
			name: "custom",
			label: "custom",
			description: "custom",
			renderResult: () => component,
		} as ToolRenderers;
		const renderer = createToolHtmlRenderer({
			getToolDefinition: () => tool,
			theme: {} as Theme,
			cwd: "/tmp",
		});

		expect(renderer.renderResult("id", "custom", [], undefined, false)?.expanded).toBe(
			'<div class="ansi-line"><span style="color:#800000">one</span></div><div class="ansi-line">two</div>',
		);
	});
});
