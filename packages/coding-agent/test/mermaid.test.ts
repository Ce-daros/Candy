import { describe, expect, it } from "vitest";
import type { MermaidRenderingMode } from "../src/core/settings-manager.ts";
import { createMermaidCodeBlockView } from "../src/modes/interactive/components/mermaid.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

function renderMermaid(
	code: string,
	options: {
		mode?: MermaidRenderingMode;
		width?: number;
		isStreaming?: boolean;
		complete?: boolean;
		language?: string;
		theme?: Theme;
	} = {},
): string[] | undefined {
	return createMermaidCodeBlockView({ getMode: () => options.mode ?? "final", theme: options.theme })(
		code,
		options.language ?? "mermaid",
		options.width ?? 100,
		options.isStreaming ?? false,
		options.complete ?? true,
	);
}

describe("Mermaid code block view", () => {
	const flow = "flowchart LR\n  A[Start] --> B[Done]";

	it("renders a completed Mermaid block as terminal art", () => {
		const lines = renderMermaid(flow);
		expect(lines?.join("\n")).toContain("┌───────┐");
		expect(lines?.join("\n")).toContain("│ Start ├───▶│ Done │");
	});

	it("leaves source view available while streaming in final mode", () => {
		expect(renderMermaid(flow, { isStreaming: true, complete: false })).toBeUndefined();
		expect(renderMermaid(flow, { isStreaming: true, complete: true })?.join("\n")).toContain("───▶");
		expect(renderMermaid(flow, { mode: "streaming", isStreaming: true })?.join("\n")).toContain("───▶");
	});

	it("respects mode, language, and available width", () => {
		expect(renderMermaid(flow, { mode: "off" })).toBeUndefined();
		expect(renderMermaid(flow, { language: "typescript" })).toBeUndefined();
		expect(renderMermaid(flow, { width: 10 })).toBeUndefined();
	});

	it("keeps unsupported or invalid diagrams as source", () => {
		expect(renderMermaid('pie\n  title Pets\n  "Dogs" : 4')).toBeUndefined();
		expect(renderMermaid("flowchart LR\n  A[Foo] invalid")).toBeUndefined();
	});

	it("styles diagram spans through the Candy theme", () => {
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => `<bold>${text}</bold>`,
		} as Theme;
		const lines = renderMermaid(flow, { theme });
		expect(lines?.join("\n")).toContain("<borderMuted>");
		expect(lines?.join("\n")).toContain("<accent>");
	});
});
