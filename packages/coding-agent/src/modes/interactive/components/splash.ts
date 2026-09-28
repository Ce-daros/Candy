import { type Component, getCapabilities, SixelImage, truncateToWidth, visibleWidth } from "@candy/tui";
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

export interface SplashResources {
	context: number;
	skills: number;
	prompts: number;
	extensions: number;
}

const basicTips = [
	() => `psst, tap ${keycap(keyText("app.model.select"))} for models.`,
	() => `in the Powerbar? ${keycap(keyText("app.powerbar.next"))} takes you to Thinking.`,
	() => `model picked? ${keycap(keyText("app.powerbar.up"))} opens Sources.`,
	() => `curious about a model? ${keycap(keyText("app.powerbar.down"))} opens its Details.`,
	() => `type ${keycap(keyText("app.command.enter"))} in an empty composer. command time, yayy.`,
	() => `need a hand? type ${keycap(keyText("app.help.enter"))} for Hotkeys.`,
	() => `type ${keycap("@")} to find a file. there it is.`,
	() => `a little shell magic: start with ${keycap("!")}.`,
	() => `Sources checkboxes make your model shortlist. pick your faves.`,
	() => `new thought, fresh page. find New session in History.`,
] as const;

const advancedTips = [
	() => `shell output just for you? start with ${keycap("!!")}.`,
	() => `History → Tree. take the other path, babe.`,
	() => `History → Fork. give that earlier idea another life.`,
	() => `still working? ${keycap(keyText("app.message.followUp"))} queues your next message.`,
	() => `big draft energy? ${keycap(keyText("app.editor.external"))} opens your external editor.`,
] as const;

const easterTips = [
	() => "also, try Terraria! tiny break, big cave.",
	() => "the cake can wait. have some Candy.",
	() => "dangerous to go alone? take a little Candy.",
	() => "stay determined, cutie.",
	() => "one more turn? nah, one more day on the farm.",
] as const;

export const SplashTips = {
	basic: basicTips,
	advanced: advancedTips,
	easter: easterTips,
} as const;

const tips = [...basicTips, ...advancedTips, ...easterTips];

/** Unicode half-block sprite of the Candy logo for terminals without image protocols. */
export class SplashLogoComponent implements Component {
	private cachedLines?: string[];
	private cachedWidth?: number;
	private maxHeight?: number;

	constructor(maxHeight?: number) {
		this.maxHeight = maxHeight;
	}

	setMaxHeight(height: number): void {
		if (this.maxHeight === height) return;
		this.maxHeight = height;
		this.invalidate();
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

export interface SplashOptions {
	version: string;
	resources: SplashResources;
	tipIndex?: number;
	getAvailableHeight?: () => number;
}

/** Brand splash screen shown for a new, empty session. */
export class SplashComponent implements Component {
	private readonly getAvailableHeight: (() => number) | undefined;
	private readonly version: string;
	private readonly tip: () => string;
	private resources: SplashResources;
	private availableHeight = 24;
	private readonly sprite = new SplashLogoComponent();
	private readonly sixel = new SixelImage(SIXEL_SEQUENCE, SIXEL_WIDTH_PX, SIXEL_HEIGHT_PX);

	constructor(options: SplashOptions) {
		this.getAvailableHeight = options.getAvailableHeight;
		this.version = options.version;
		this.resources = options.resources;
		const index = options.tipIndex ?? Math.floor(Math.random() * tips.length);
		this.tip = tips[index];
	}

	setResources(resources: SplashResources): void {
		this.resources = resources;
	}

	setAvailableHeight(height: number): void {
		this.availableHeight = Math.max(1, Math.floor(height));
		this.invalidate();
	}

	invalidate(): void {
		this.sprite.invalidate();
		this.sixel.invalidate();
	}

	render(width: number): string[] {
		if (this.getAvailableHeight) this.availableHeight = this.getAvailableHeight();
		const capability = getCapabilities().images;
		const sixelLines = capability === "sixel" ? this.sixel.render(width) : [];
		const logoRows = capability === "sixel" ? sixelLines.length : Math.ceil(SPRITE_ROWS / 2);
		const fixedRows = 5;
		const maxLogoRows = Math.max(2, this.availableHeight - fixedRows);
		const useSixel = capability === "sixel" && logoRows <= maxLogoRows;
		this.sprite.setMaxHeight(maxLogoRows);
		const logo = useSixel ? sixelLines : this.sprite.render(width);
		const resources = `${this.resources.context} context · ${this.resources.skills} skills · ${this.resources.prompts} prompts · ${this.resources.extensions} extensions`;
		const content = [
			...logo,
			"",
			center(theme.fg("accent", `Candy (${this.version})`), width),
			center(resources, width),
			"",
			center(theme.fg("dim", this.tip()), width),
		];
		const height = Math.min(this.availableHeight, content.length);
		const top = Math.floor((this.availableHeight - height) / 2);
		const bottom = Math.min(this.availableHeight - height - top, this.availableHeight);
		return [...Array<string>(top).fill(""), ...content.slice(0, height), ...Array<string>(bottom).fill("")];
	}
}

function center(value: string, width: number): string {
	return truncateToWidth(
		`${" ".repeat(Math.max(0, Math.floor((width - visibleWidth(value)) / 2)))}${value}`,
		width,
		"",
	);
}
