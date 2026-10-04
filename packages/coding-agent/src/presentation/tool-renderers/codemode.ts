import { Text } from "@candy/tui";
import type { CodemodeToolDetails } from "../../core/codemode-tool.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolRenderers } from "../tool-render-types.ts";
import { getTextOutput } from "../tool-render-utils.ts";

export const codemodeRenderers: ToolRenderers<{ code: string }, CodemodeToolDetails> = {
	renderCall(args, _theme, context) {
		const firstLine = typeof args?.code === "string" ? args.code.trim().split("\n", 1)[0] : "";
		const summary = firstLine.length > 90 ? `${firstLine.slice(0, 87)}…` : firstLine;
		const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		text.setText(theme.fg("toolTitle", theme.bold(`codemode ${summary || "JavaScript"}`)));
		return text;
	},
	renderResult(result, options, _theme, context) {
		const lines: string[] = [];
		const calls = result.details?.calls ?? [];
		const shown = options.expanded ? calls : calls.slice(-context.previewLines);
		if (!options.expanded && calls.length > shown.length)
			lines.push(theme.fg("muted", `${calls.length - shown.length} earlier calls`));
		for (const call of shown) {
			const duration = call.durationMs === undefined ? "" : ` · ${call.durationMs}ms`;
			lines.push(
				theme.fg(call.status === "error" ? "error" : "toolOutput", `${call.name} · ${call.status}${duration}`),
			);
			if (options.expanded) {
				lines.push(theme.fg("muted", `  ${call.args}`));
				if (call.error) lines.push(theme.fg("error", `  ${call.error}`));
			}
		}
		const output = getTextOutput(result, context.showImages).trim();
		if (output) {
			if (lines.length) lines.push("");
			const outputLines = output.split("\n");
			const visible = options.expanded ? outputLines : outputLines.slice(0, context.previewLines);
			lines.push(...visible.map((line) => theme.fg("toolOutput", line)));
			if (!options.expanded && outputLines.length > visible.length)
				lines.push(theme.fg("muted", "Expand for full output"));
		}
		const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		text.setText(lines.join("\n"));
		return text;
	},
};
