import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Marked } from "marked";

interface TemplateRenderer {
	renderEntry(entry: Record<string, unknown>): string;
	getTreeNodeDisplayHtml(entry: Record<string, unknown>, label?: string): string;
	renderHeader(): string;
	safeMarkedParse(text: string): string;
}

export function createTemplateRenderer(entries: Record<string, unknown>[] = []): TemplateRenderer {
	const source = readFileSync(new URL("../src/presentation/export-html/template.js", import.meta.url), "utf8");
	// Execute the export's data and rendering setup before it attaches DOM event handlers.
	const initializationEnd = source.indexOf("      // Search input");
	if (initializationEnd < 0) throw new Error("Export template initialization boundary is missing");
	const sessionData = Buffer.from(JSON.stringify({ header: { id: "test" }, entries })).toString("base64");
	return runInNewContext(
		`${source.slice(0, initializationEnd)}let thinkingExpanded = true, toolOutputsExpanded = false, showHiddenMessages = false; return { renderEntry, getTreeNodeDisplayHtml, renderHeader, safeMarkedParse }; })();`,
		{
			document: {
				getElementById: () => ({ textContent: sessionData }),
				querySelector: () => null,
			},
			window: { location: { search: "" } },
			atob,
			TextDecoder,
			URLSearchParams,
			marked: new Marked(),
		},
	) as TemplateRenderer;
}
