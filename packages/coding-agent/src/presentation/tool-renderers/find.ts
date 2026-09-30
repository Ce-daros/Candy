/**
 * Presentation for the find tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `find.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { Text } from "@candy/tui";
import type { Theme } from "../../contracts/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../core/extensions/types.ts";
import type { FindToolDetails } from "../../core/tools/find.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../../core/tools/truncate.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "../tool-render-utils.ts";

function formatFindCall(args: { pattern: string; path?: string; limit?: number } | undefined, theme: Theme): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("find")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}
function formatFindResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: FindToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	isError: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!options.expanded && !isError) {
		const files =
			output === "No files found matching pattern"
				? 0
				: output.split("\n").filter((line) => line && !line.startsWith("[")).length;
		return theme.fg("dim", `${files} ${files === 1 ? "file" : "files"}`);
	}
	let text = "";
	if (output) {
		const lines = output.split("\n");
		text += lines.map((line) => theme.fg("toolOutput", line)).join("\n");
	}

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export const findRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatFindCall(args as any, theme));
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatFindResult(result as any, options, theme, context.showImages, context.isError));
		return text;
	},
};
