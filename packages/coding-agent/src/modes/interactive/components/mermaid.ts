import { type MermaidArt, render, type Span } from "grok-mermaid";
import type { MermaidRenderingMode } from "../../../core/settings-manager.ts";
import type { Theme } from "../theme/theme.ts";

interface MermaidCodeBlockViewOptions {
	getMode: () => MermaidRenderingMode;
	theme?: Theme;
}

/** Render a complete Mermaid code block while keeping its source available to Markdown. */
export function createMermaidCodeBlockView(options: MermaidCodeBlockViewOptions) {
	return (
		code: string,
		language: string | undefined,
		width: number,
		isStreaming: boolean,
		complete: boolean,
	): string[] | undefined => {
		if (language?.trim().split(/\s+/, 1)[0]?.toLowerCase() !== "mermaid") return undefined;
		const mode = options.getMode();
		if (mode === "off" || (isStreaming && !complete && mode !== "streaming")) return undefined;
		const art = render(code);
		if (!art || art.width > width || art.warnings.length > 0) return undefined;
		return options.theme ? themedLines(art, options.theme) : art.plain;
	};
}

function styleSpan(span: Span, theme: Theme): string {
	switch (span.cls) {
		case "border":
			return theme.fg("borderMuted", span.text);
		case "text":
			return theme.fg("text", span.text);
		case "edge":
			return theme.fg("accent", span.text);
		case "edgeLabel":
			return theme.fg("muted", span.text);
		case "title":
			return theme.fg("accent", theme.bold(span.text));
		case "none":
			return span.text;
	}
}

function themedLines(art: MermaidArt, theme: Theme): string[] {
	return art.styled.map((row) => row.map((span) => styleSpan(span, theme)).join(""));
}
