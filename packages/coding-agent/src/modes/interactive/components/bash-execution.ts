import { Container, Loader, type TUI, type TuiMouseEvent, truncateToWidth } from "@candy/tui";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

const GUTTER_WIDTH = 6;

export class BashExecutionComponent extends Container {
	private readonly command: string;
	private readonly excludeFromContext: boolean;
	private readonly startedAt = Date.now();
	private outputLines: string[] = [];
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined;
	private readonly loader: Loader;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	private expanded = false;
	private previewLines: 5 | 10 | 20;
	private elapsed = 0;

	constructor(command: string, ui: TUI, excludeFromContext = false, previewLines: 5 | 10 | 20 = 5) {
		super();
		this.command = command;
		this.excludeFromContext = excludeFromContext;
		this.previewLines = previewLines;
		this.loader = new Loader(
			ui,
			(spinner) => theme.fg("bashMode", spinner),
			(text) => theme.fg("dim", text),
			"Running…",
		);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	setPreviewLines(lines: 5 | 10 | 20): void {
		this.previewLines = lines;
	}

	override invalidate(): void {
		this.loader.invalidate();
	}

	appendOutput(chunk: string): void {
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled ? "cancelled" : exitCode !== 0 && exitCode !== undefined ? "error" : "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;
		this.elapsed = Date.now() - this.startedAt;
		this.loader.stop();
	}

	override render(width: number): string[] {
		const contentWidth = Math.max(1, width - GUTTER_WIDTH);
		const node =
			this.status === "complete"
				? theme.fg("success", "✓")
				: this.status === "error"
					? theme.fg("error", "×")
					: this.status === "cancelled"
						? theme.fg("muted", "⊘")
						: theme.fg("warning", "◇");
		const arrow = this.expanded ? "▾" : "▸";
		const commandLabel = `${this.excludeFromContext ? "!!" : "!"} ${this.command}`;
		const title = theme.fg("bashMode", theme.bold(commandLabel));
		const duration = this.status === "running" ? "" : theme.fg("dim", `  ${(this.elapsed / 1000).toFixed(1)}s`);
		const heading = `${node}${theme.fg("borderMuted", "─")} ${theme.fg("muted", arrow)} ${title}${duration}`;
		const lines = [truncateToWidth(heading, width, "…")];
		const rail = `${theme.fg("borderMuted", "│")}     `;
		if (this.excludeFromContext) lines.push(`${rail}${theme.fg("dim", "Excluded from model context")}`);

		const fullOutput = this.outputLines.join("\n");
		const contextOutput = truncateTail(fullOutput, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		if (contextOutput.content) {
			const styled = contextOutput.content
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");
			const preview = this.expanded
				? {
						visualLines: truncateToVisualLines(styled, Number.MAX_SAFE_INTEGER, contentWidth).visualLines,
						skippedCount: 0,
					}
				: truncateToVisualLines(styled, this.status === "error" ? 12 : this.previewLines, contentWidth);
			if (preview.skippedCount > 0)
				lines.push(`${rail}${theme.fg("dim", `… ${preview.skippedCount} earlier lines`)}`);
			lines.push(...preview.visualLines.map((line) => `${rail}${line}`));
		}
		if (this.status === "running") {
			lines.push(...this.loader.render(contentWidth).map((line) => `${rail}${line}`));
		} else if (this.status === "cancelled") {
			lines.push(`${rail}${theme.fg("muted", "Cancelled")}`);
		} else if (this.status === "error") {
			lines.push(`${rail}${theme.fg("error", `Exit ${this.exitCode}`)}`);
		}
		if ((this.truncationResult?.truncated || contextOutput.truncated) && this.fullOutputPath) {
			lines.push(
				`${rail}${truncateToWidth(theme.fg("warning", `Full output: ${this.fullOutputPath}`), contentWidth, "…")}`,
			);
		}
		return lines;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.type === "click" && event.button === "left" && event.y === 0) {
			this.expanded = !this.expanded;
			return {
				handled: true,
				target: {
					component: this,
					originX: event.screenX - event.x,
					originY: event.screenY - event.y,
					width: event.width,
					height: event.height,
				},
			};
		}
		return undefined;
	}

	getOutput(): string {
		return this.outputLines.join("\n");
	}

	getCommand(): string {
		return this.command;
	}
}
