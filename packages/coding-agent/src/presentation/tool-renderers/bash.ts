/**
 * Presentation for the shell tools.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema.
 */

import { Container, Text } from "@candy/tui";
import type { BashToolDetails } from "../../core/tools/bash.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../../core/tools/truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolRenderers } from "../tool-render-types.ts";
import { getTextOutput, invalidArgText, str } from "../tool-render-utils.ts";

function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;

	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;

	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}
function formatShellCall(
	args: { command?: string; timeout?: number } | undefined,
	prompt: string,
	toolName: string,
	startedAt: number | undefined,
	endedAt: number | undefined,
): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	const duration =
		startedAt === undefined
			? ""
			: theme.fg(
					"muted",
					`  ${endedAt === undefined ? "Elapsed" : "Took"} ${formatDuration((endedAt ?? Date.now()) - startedAt)}`,
				);
	return theme.fg("toolTitle", theme.bold(`${toolName} ${prompt} ${commandDisplay}`)) + timeoutSuffix + duration;
}
function rebuildBashResultRenderComponent(
	component: Container,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	showImages: boolean,
	isPartial: boolean,
): void {
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		component.addChild(new Text(styledOutput, 0, 0));
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}
}

/** Shell renderers are shared by bash and powershell, which differ only in the prompt they display. */
export function createShellRenderers(prompt: string, toolName: string): ToolRenderers<any, BashToolDetails> {
	return {
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatShellCall(
					args as { command?: string; timeout?: number } | undefined,
					prompt,
					toolName,
					state.startedAt,
					state.endedAt,
				),
			);
			state.callComponent = text;
			state.callArgs = args;
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			if (state.callComponent) {
				state.callComponent.setText(
					formatShellCall(state.callArgs, prompt, toolName, state.startedAt, state.endedAt),
				);
			}
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			rebuildBashResultRenderComponent(component, result as any, context.showImages, options.isPartial);
			component.invalidate();
			return component;
		},
	};
}
