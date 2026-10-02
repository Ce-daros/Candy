import {
	type Component,
	calculateSixelCellSize,
	getCapabilities,
	SixelImage,
	truncateToWidth,
	visibleWidth,
} from "@candy/tui";
import { theme } from "../theme/theme.ts";
import { keycap, keyText } from "./keybinding-hints.ts";
import { SIXEL_HEIGHT_PX, SIXEL_SEQUENCE, SIXEL_WIDTH_PX } from "./splash-logo.generated.ts";

export interface SplashResources {
	context: number;
	skills: number;
	prompts: number;
	extensions: number;
}

const basicTips = [
	() => `psst, tap ${keycap(keyText("app.model.select"))} for models.`,
	() => `press ${keycap("Esc Esc")} for Actions.`,
	() => `press ${keycap(keyText("app.thinking.cycle"))} to change thinking effort.`,
	() => `type ${keycap(keyText("app.command.enter"))} in an empty composer. command time, yayy.`,
	() => `need a hand? type ${keycap(keyText("app.help.enter"))} for Hotkeys.`,
	() => `type ${keycap("@")} to find a file. there it is.`,
	() => `a little shell magic: start with ${keycap("!")}.`,
	() => `Sources checkboxes make your model shortlist. pick your faves.`,
	() => `new thought, fresh page. find New session in Actions.`,
] as const;

const advancedTips = [
	() => `shell output just for you? start with ${keycap("!!")}.`,
	() => `Actions → Tree. take the other path, babe.`,
	() => `Actions → Fork. give that earlier idea another life.`,
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

export class SplashLogoComponent implements Component {
	private readonly image = new SixelImage(SIXEL_SEQUENCE, SIXEL_WIDTH_PX, SIXEL_HEIGHT_PX);
	private maxHeight: number;

	constructor(maxHeight = Infinity) {
		this.maxHeight = maxHeight;
	}

	setMaxHeight(height: number): void {
		this.maxHeight = height;
	}

	invalidate(): void {
		this.image.invalidate();
	}

	render(width: number): string[] {
		if (getCapabilities().images !== "sixel") return [];
		const { columns, rows } = calculateSixelCellSize(SIXEL_WIDTH_PX, SIXEL_HEIGHT_PX);
		if (columns > width || rows > this.maxHeight) return [];
		return this.image.render(width);
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
	private readonly logo = new SplashLogoComponent();

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
		this.logo.invalidate();
	}

	render(width: number): string[] {
		if (this.getAvailableHeight) this.availableHeight = this.getAvailableHeight();
		this.logo.setMaxHeight(this.availableHeight - 5);
		const logo = this.logo.render(width);
		const resources = `${this.resources.context} context · ${this.resources.skills} skills · ${this.resources.prompts} prompts · ${this.resources.extensions} extensions`;
		const content = [
			...logo,
			...(logo.length > 0 ? [""] : []),
			center(theme.fg("accent", `Candy (${this.version})`), width),
			center(resources, width),
			"",
			center(theme.fg("dim", this.tip()), width),
		];
		const height = Math.min(this.availableHeight, content.length);
		const top = Math.max(0, Math.floor((this.availableHeight - height) / 2));
		const bottom = Math.max(0, this.availableHeight - height - top);
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
