import {
	type Component,
	Container,
	getCapabilities,
	SixelImage,
	Spacer,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@candy/tui";
import { theme } from "../theme/theme.ts";
import { keycap, keyText } from "./keybinding-hints.ts";
import {
	SIXEL_HEIGHT_PX,
	SIXEL_SEQUENCE,
	SIXEL_WIDTH_PX,
	SPRITE_COLUMNS,
	SPRITE_GRID,
	SPRITE_PALETTE,
	SPRITE_ROWS,
} from "./splash-logo.generated.ts";

const TIPS = [
	() => `${theme.fg("dim", "Type ")}${keycap("@")}${theme.fg("dim", " to find a file.")}`,
	() => `${theme.fg("dim", "Use ")}${keycap("!")}${theme.fg("dim", " to run a shell command.")}`,
	() => `${theme.fg("dim", "Use ")}${keycap("!!")}${theme.fg("dim", " to run a command outside model context.")}`,
	() => `${theme.fg("dim", "Use ")}${keycap(keyText("app.model.select"))}${theme.fg("dim", " to choose a model.")}`,
	() =>
		`${theme.fg("dim", "Press ")}${keycap(keyText("app.powerbar.next"))}${theme.fg("dim", " in the Powerbar to choose Thinking.")}`,
	() => theme.fg("dim", "Open History to revisit a conversation branch."),
	() => theme.fg("dim", "Open History to fork an earlier message."),
	() => theme.fg("dim", "Click an activity title to expand its details."),
	() => theme.fg("dim", "Open Command to change the theme."),
	() => theme.fg("dim", "Open History to see usage and session details."),
] as const;

/** Unicode half-block sprite of the Candy logo for terminals without image protocols. */
export class SplashLogoComponent implements Component {
	private cachedLines?: string[];
	private cachedWidth?: number;
	private readonly maxHeight?: number;

	constructor(maxHeight?: number) {
		this.maxHeight = maxHeight;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const rows = SPRITE_GRID.split("\n");
		const palette = SPRITE_PALETTE;
		const scale = Math.min(
			1,
			Math.max(1, width) / SPRITE_COLUMNS,
			this.maxHeight === undefined ? 1 : Math.max(1, this.maxHeight) / (SPRITE_ROWS / 2),
		);
		const columns = Math.max(1, Math.floor(SPRITE_COLUMNS * scale));
		const pixelRows = Math.max(2, 2 * Math.floor((SPRITE_ROWS * scale) / 2));
		const left = " ".repeat(Math.max(0, Math.floor((width - columns) / 2)));
		const lines: string[] = [];
		const sample = (x: number, y: number): number => {
			const counts = Array<number>(palette.length).fill(0);
			let index = -1;
			let bestCount = 0;
			for (
				let sourceY = Math.floor((y * SPRITE_ROWS) / pixelRows);
				sourceY < Math.ceil(((y + 1) * SPRITE_ROWS) / pixelRows);
				sourceY++
			) {
				for (
					let sourceX = Math.floor((x * SPRITE_COLUMNS) / columns);
					sourceX < Math.ceil(((x + 1) * SPRITE_COLUMNS) / columns);
					sourceX++
				) {
					const cell = rows[sourceY][sourceX];
					if (cell === ".") continue;
					const color = parseInt(cell, 16);
					const count = ++counts[color];
					if (count > bestCount) {
						index = color;
						bestCount = count;
					}
				}
			}
			return index;
		};

		for (let y = 0; y + 1 < pixelRows; y += 2) {
			let line = "";
			for (let x = 0; x < columns; x++) {
				const top = sample(x, y);
				const bottom = sample(x, y + 1);
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
			lines.push(truncateToWidth(left + line, width, ""));
		}

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

class SplashActions implements Component {
	private readonly tip = TIPS[Math.floor(Math.random() * TIPS.length)];
	private readonly onCommand: ((command: string) => void) | undefined;
	private regions: { start: number; end: number; command: string }[] = [];

	constructor(onCommand?: (command: string) => void) {
		this.onCommand = onCommand;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const commands = ["History", "Command", "Hotkeys"];
		const text = commands.join("     ");
		let column = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
		const left = " ".repeat(column);
		this.regions = commands.map((command) => {
			const region = { start: column, end: column + command.length, command };
			column += command.length + 5;
			return region;
		});
		const tip = truncateToWidth(this.tip(), width, "");
		return [
			truncateToWidth(left + commands.map((command) => theme.fg("accent", command)).join("     "), width, ""),
			"",
			" ".repeat(Math.max(0, Math.floor((width - visibleWidth(tip)) / 2))) + tip,
		];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || event.y !== 0) return;
		const region = this.regions.find((region) => event.x >= region.start && event.x < region.end);
		if (!region || !this.onCommand) return;
		this.onCommand(region.command);
		return { handled: true };
	}
}

/**
 * Brand splash screen shown on startup: the Candy logo (Sixel image when the
 * terminal supports it, Unicode half-block sprite otherwise) with a short
 * action row. Removed once the first user message is submitted.
 */
export class SplashComponent extends Container {
	constructor(onCommand?: (command: string) => void) {
		super();
		this.addChild(new Spacer(2));
		if (getCapabilities().images === "sixel") {
			this.addChild(new SixelImage(SIXEL_SEQUENCE, SIXEL_WIDTH_PX, SIXEL_HEIGHT_PX));
		} else {
			this.addChild(new SplashLogoComponent());
		}
		this.addChild(new Spacer(1));
		this.addChild(new SplashActions(onCommand));
		this.addChild(new Spacer(1));
	}
}
