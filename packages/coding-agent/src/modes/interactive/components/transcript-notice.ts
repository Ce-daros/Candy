import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@candy/tui";
import { truncateToWidth, wrapTextWithAnsi } from "@candy/tui";
import { theme } from "../theme/theme.ts";

export interface TranscriptNoticeOptions {
	tone: "error" | "warning" | "info";
	title: string;
	body: string;
	onOpen?: () => void;
}

export class TranscriptNotice implements Component {
	private expanded = false;
	private headingRows = 1;
	private renderedHeight = 0;

	private readonly options: TranscriptNoticeOptions;

	constructor(options: TranscriptNoticeOptions) {
		this.options = options;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	render(width: number): string[] {
		const tone = this.options.tone;
		const color = tone === "error" ? "error" : tone === "warning" ? "warning" : "muted";
		const marker = tone === "error" ? "×" : tone === "warning" ? "!" : "·";
		const innerWidth = Math.max(1, width - 2);
		const wrapped = this.options.body ? wrapTextWithAnsi(this.options.body, innerWidth) : [];
		const collapsed = !this.expanded && wrapped.length > 4;
		const visibleBody = collapsed ? wrapped.slice(0, 4) : wrapped;
		const lines = [
			`${theme.fg(color, marker)} ${theme.fg(color, theme.bold(this.options.title))}`,
			...visibleBody.map((line) => `${theme.fg("borderMuted", "│")} ${theme.fg("text", line)}`),
		];
		if (collapsed) lines.push(`${theme.fg("borderMuted", "│")} ${theme.fg("dim", "…")}`);
		this.headingRows = 1;
		this.renderedHeight = lines.length;
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || event.y < 0 || event.y >= this.renderedHeight) {
			return undefined;
		}
		if (event.y < this.headingRows && this.options.onOpen) this.options.onOpen();
		else this.expanded = !this.expanded;
		return { handled: true, render: true };
	}

	invalidate(): void {}
}
