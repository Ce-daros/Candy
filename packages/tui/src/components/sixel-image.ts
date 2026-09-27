import { calculateSixelCellSize, getCellDimensions } from "../terminal-image.ts";
import type { Component } from "../tui.ts";

/**
 * Renders a pre-encoded Sixel sequence (DCS ... ST) as an inline image.
 *
 * The sequence is produced ahead of time (e.g. build-time baked assets); this
 * component only handles cell accounting: it reserves the rows the image's
 * pixel height occupies at the current cell size and optionally centers the
 * plot origin with a cursor-forward prefix.
 */
export class SixelImage implements Component {
	private sequence: string;
	private widthPx: number;
	private heightPx: number;

	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(sequence: string, widthPx: number, heightPx: number) {
		this.sequence = sequence;
		this.widthPx = widthPx;
		this.heightPx = heightPx;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const cellDimensions = getCellDimensions();
		const { columns, rows } = calculateSixelCellSize(this.widthPx, this.heightPx, cellDimensions);
		const leftPad = Math.max(0, Math.floor((width - columns) / 2));

		const lines: string[] = [];
		// Sixel plots at the active cursor position; reserve rows first, then the
		// first line shifts the cursor right and transmits the sequence. Subsequent
		// rows are absolutely positioned by the renderer, so the cursor landing
		// inside/below the image after ST (terminal-dependent) does not matter.
		const cursorForward = leftPad > 0 ? `\x1b[${leftPad}C` : "";
		lines.push(cursorForward + this.sequence);
		for (let i = 1; i < rows; i++) {
			lines.push("");
		}

		this.cachedLines = lines;
		this.cachedWidth = width;

		return lines;
	}
}
