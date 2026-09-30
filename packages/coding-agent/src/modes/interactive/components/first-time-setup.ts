import { Container, getKeybindings, moveSelection, Spacer, Text } from "@candy/tui";
import {
	infoLine,
	selectedRowLabel,
	selectionCursor,
	selectionMarkerSuffix,
	type TerminalTheme,
	theme,
} from "../theme/theme.ts";
import { hintRow } from "./keybinding-hints.ts";
import { SplashLogoComponent } from "./splash.ts";

export interface FirstTimeSetupResult {
	theme: TerminalTheme;
}

export interface FirstTimeSetupOptions {
	detectedTheme: TerminalTheme;
	getAvailableHeight?: () => number;
	onThemePreview: (themeName: TerminalTheme) => void;
	onSubmit: (result: FirstTimeSetupResult) => void;
	onCancel: () => void;
}

const THEME_OPTIONS: Array<{ value: TerminalTheme; label: string }> = [
	{ value: "dark", label: "Dark" },
	{ value: "light", label: "Light" },
];

/** First-time setup dialog for choosing a theme. */
export class FirstTimeSetupComponent extends Container {
	private themeIndex: number;
	private readonly options: FirstTimeSetupOptions;
	private availableHeight: number;

	constructor(options: FirstTimeSetupOptions) {
		super();
		this.options = options;
		this.availableHeight = options.getAvailableHeight?.() ?? Infinity;
		this.themeIndex = Math.max(
			0,
			THEME_OPTIONS.findIndex((option) => option.value === options.detectedTheme),
		);
		this.update();
	}

	override render(width: number): string[] {
		const height = this.options.getAvailableHeight?.() ?? this.availableHeight;
		if (height !== this.availableHeight) {
			this.availableHeight = height;
			this.update();
		}
		return super.render(width);
	}

	// Rebuild the whole dialog on every change so theme previews recolor all text.
	private update(): void {
		this.clear();
		const compact = this.availableHeight <= 26;
		if (!compact) this.addChild(new Spacer(1));
		this.addChild(new SplashLogoComponent(this.availableHeight <= 18 ? 4 : compact ? 8 : undefined));
		if (!compact) this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold(theme.fg("accent", "Theme")), 1, 0));

		this.addChild(new Text(theme.fg("text", "Choose a theme"), 1, 0));
		this.addChild(new Text(infoLine("Detected system appearance", this.options.detectedTheme), 1, 0));
		this.addChild(new Spacer(1));
		this.addOptionList(
			THEME_OPTIONS.map((option) => option.label),
			this.themeIndex,
		);

		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				hintRow([
					{ raw: "↑↓", label: "navigate" },
					{
						key: "tui.select.confirm",
						label: "save",
					},
					{ key: "tui.select.cancel", label: "skip setup" },
				]),
				1,
				0,
			),
		);
	}

	private addOptionList(labels: string[], selectedIndex: number): void {
		for (let i = 0; i < labels.length; i++) {
			const isSelected = i === selectedIndex;
			const label = isSelected
				? `${selectionCursor(true)}${selectedRowLabel(labels[i], true)}${selectionMarkerSuffix(true)}`
				: `${selectionCursor(false)}${theme.fg("text", labels[i])}`;
			this.addChild(new Text(label, 1, 0));
		}
	}

	private moveSelection(delta: number): void {
		const next = moveSelection(this.themeIndex, THEME_OPTIONS.length, delta);
		if (next !== this.themeIndex) {
			this.themeIndex = next;
			this.options.onThemePreview(THEME_OPTIONS[this.themeIndex].value);
		}
		this.update();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.moveSelection(-1);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.moveSelection(1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.options.onSubmit({ theme: THEME_OPTIONS[this.themeIndex].value });
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.options.onCancel();
		}
	}
}
