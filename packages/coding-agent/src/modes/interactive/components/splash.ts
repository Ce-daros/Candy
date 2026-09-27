import { type Component, Container, getCapabilities, SixelImage, Spacer } from "@candy/tui";
import { theme } from "../theme/theme.ts";
import {
	SIXEL_HEIGHT_PX,
	SIXEL_SEQUENCE,
	SIXEL_WIDTH_PX,
	SPRITE_COLUMNS,
	SPRITE_GRID,
	SPRITE_PALETTE,
} from "./splash-logo.generated.ts";

const TAGLINE_LINE_1 = "beauty, art, and function";
const TAGLINE_LINE_2 = "in a workspace for thinking and making";

/** Unicode half-block sprite of the Candy logo for terminals without image protocols. */
class SpriteLogo implements Component {
	private cachedLines?: string[];
	private cachedWidth?: number;

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const rows = SPRITE_GRID.split("\n");
		const palette = SPRITE_PALETTE;
		const left = " ".repeat(Math.max(0, Math.floor((width - SPRITE_COLUMNS) / 2)));
		const lines: string[] = [];

		for (let y = 0; y + 1 < rows.length; y += 2) {
			let line = "";
			for (let x = 0; x < SPRITE_COLUMNS; x++) {
				const top = rows[y][x] === "." ? -1 : parseInt(rows[y][x], 16);
				const bottom = rows[y + 1][x] === "." ? -1 : parseInt(rows[y + 1][x], 16);
				if (top === -1 && bottom === -1) {
					line += " ";
					continue;
				}
				const rgb = (i: number) => `${palette[i][0]};${palette[i][1]};${palette[i][2]}`;
				if (top === bottom) {
					line += `\x1b[48;2;${rgb(top)}m \x1b[0m`;
				} else if (bottom === -1) {
					line += `\x1b[38;2;${rgb(top)}m▀\x1b[0m`;
				} else if (top === -1) {
					line += `\x1b[38;2;${rgb(bottom)}m▄\x1b[0m`;
				} else {
					line += `\x1b[38;2;${rgb(top)}m\x1b[48;2;${rgb(bottom)}m▀\x1b[0m`;
				}
			}
			lines.push(left + line);
		}

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

/** Centered muted tagline (plain-text lines, colored after padding is computed). */
class Tagline implements Component {
	private cachedLines?: string[];
	private cachedWidth?: number;

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedLines = [TAGLINE_LINE_1, TAGLINE_LINE_2].map((line) => {
			const pad = Math.max(0, Math.floor((width - line.length) / 2));
			return " ".repeat(pad) + theme.fg("muted", line);
		});
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

/**
 * Brand splash screen shown on startup: the Candy logo (Sixel image when the
 * terminal supports it, Unicode half-block sprite otherwise) with a short
 * tagline. Removed once the first user message is submitted.
 */
export class SplashComponent extends Container {
	constructor() {
		super();
		this.addChild(new Spacer(2));
		if (getCapabilities().images === "sixel") {
			this.addChild(new SixelImage(SIXEL_SEQUENCE, SIXEL_WIDTH_PX, SIXEL_HEIGHT_PX));
		} else {
			this.addChild(new SpriteLogo());
		}
		this.addChild(new Spacer(1));
		this.addChild(new Tagline());
		this.addChild(new Spacer(1));
	}
}
