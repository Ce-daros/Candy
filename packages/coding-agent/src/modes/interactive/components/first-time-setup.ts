import { Container, getKeybindings, Spacer, Text } from "@candy/tui";
import { type TerminalTheme, theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";
import { SplashLogoComponent } from "./splash.ts";

export interface FirstTimeSetupResult {
	theme: TerminalTheme;
	shareAnalytics: boolean;
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

const ANALYTICS_OPTIONS: Array<{ value: boolean; label: string }> = [
	{ value: true, label: "Share anonymous usage data" },
	{ value: false, label: "Don't share" },
];

/** First-time setup dialog: theme choice and analytics opt-in. */
export class FirstTimeSetupComponent extends Container {
	private step: "theme" | "analytics" = "theme";
	private themeIndex: number;
	private analyticsIndex = 0;
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
		this.addChild(
			new Text(
				theme.bold(theme.fg("accent", this.step === "theme" ? "Theme · 1 of 2" : "Data sharing · 2 of 2")),
				1,
				0,
			),
		);

		if (this.step === "theme") {
			this.addChild(new Text(theme.fg("text", "Choose a theme"), 1, 0));
			this.addChild(new Text(theme.fg("muted", `Detected system appearance: ${this.options.detectedTheme}`), 1, 0));
			this.addChild(new Spacer(1));
			this.addOptionList(
				THEME_OPTIONS.map((option) => option.label),
				this.themeIndex,
			);
		} else {
			this.addChild(new Text(theme.fg("text", "Share anonymous usage data?"), 1, 0));
			this.addChild(
				new Text(
					theme.fg("muted", "Your choice is saved in settings. You can change it later with /privacy."),
					1,
					0,
				),
			);
			this.addChild(new Spacer(1));
			this.addOptionList(
				ANALYTICS_OPTIONS.map((option) => option.label),
				this.analyticsIndex,
			);
		}

		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", this.step === "theme" ? "continue" : "finish") +
					"  " +
					keyHint("tui.select.cancel", "skip setup"),
				1,
				0,
			),
		);
	}

	private addOptionList(labels: string[], selectedIndex: number): void {
		for (let i = 0; i < labels.length; i++) {
			const isSelected = i === selectedIndex;
			const label = isSelected
				? `${theme.fg("borderAccent", "♦ ")}${theme.bold(theme.fg("accent", labels[i]))}${theme.fg("borderAccent", " ♦")}`
				: theme.fg("text", `  ${labels[i]}`);
			this.addChild(new Text(label, 1, 0));
		}
	}

	private moveSelection(delta: number): void {
		if (this.step === "theme") {
			const next = Math.max(0, Math.min(THEME_OPTIONS.length - 1, this.themeIndex + delta));
			if (next !== this.themeIndex) {
				this.themeIndex = next;
				this.options.onThemePreview(THEME_OPTIONS[this.themeIndex].value);
			}
		} else {
			this.analyticsIndex = Math.max(0, Math.min(ANALYTICS_OPTIONS.length - 1, this.analyticsIndex + delta));
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
			if (this.step === "theme") {
				this.step = "analytics";
				this.update();
			} else {
				this.options.onSubmit({
					theme: THEME_OPTIONS[this.themeIndex].value,
					shareAnalytics: ANALYTICS_OPTIONS[this.analyticsIndex].value,
				});
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.options.onCancel();
		}
	}
}
