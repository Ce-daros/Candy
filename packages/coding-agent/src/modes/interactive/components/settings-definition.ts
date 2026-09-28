import type { ThinkingLevel } from "@candy/agent-core";
import type { Transport } from "@candy/ai";
import {
	type Component,
	Container,
	foregroundAnsi,
	getCapabilities,
	getTerminalColorMode,
	parseColor,
	type ScrollViewScrollbar,
	type SelectItem,
	type SettingItem,
	SettingsList,
	type SettingsListOnChange,
	Spacer,
	Text,
} from "@candy/tui";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import {
	type AnimationIntensity,
	CACHE_WARMING_MODES,
	type CacheWarmingMode,
	type DefaultProjectTrust,
	type FullscreenExitOutput,
	type MermaidRenderingMode,
	type WarningSettings,
} from "../../../core/settings-manager.ts";
import {
	getResolvedThemeColors,
	getSettingsListTheme,
	parseAutoThemeSetting,
	type TerminalTheme,
	theme,
} from "../theme/theme.ts";
import { keycap, keyDisplayText } from "./keybinding-hints.ts";
import { SelectSubmenu } from "./settings-submenu.ts";

const DEFAULT_PROJECT_TRUST_LABELS: Record<DefaultProjectTrust, string> = {
	ask: "Ask",
	always: "Always trust",
	never: "Never trust",
};

const DEFAULT_PROJECT_TRUST_BY_LABEL = new Map(
	Object.entries(DEFAULT_PROJECT_TRUST_LABELS).map(([value, label]) => [label, value as DefaultProjectTrust]),
);

export interface SettingsConfig {
	autoCompact: boolean;
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	httpIdleTimeoutMs: number;
	cacheWarmingMode: CacheWarmingMode;
	thinkingLevel: ThinkingLevel;
	currentTheme: string;
	uiAnimations: boolean;
	animationIntensity: AnimationIntensity;
	terminalTheme: TerminalTheme;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	mermaidRenderingMode: MermaidRenderingMode;
	showCacheMissNotices: boolean;
	collapseChangelog: boolean;
	enableInstallTelemetry: boolean;
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	toolPreviewLines: 5 | 10 | 20;
	showHardwareCursor: boolean;
	editorPaddingX: number;
	outputPad: 0 | 1;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
	defaultProjectTrust: DefaultProjectTrust;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	fullscreenExitOutput: FullscreenExitOutput;
	fullscreenScrollbar: ScrollViewScrollbar;
	fullscreenCopyOnSelect: boolean;
	warnings: WarningSettings;
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void | Promise<void>;
	onDefaultThinkingLevelChange: (level: ThinkingLevel) => void | Promise<void>;
	onShowImagesChange: (enabled: boolean) => void | Promise<void>;
	onImageWidthCellsChange: (width: number) => void | Promise<void>;
	onAutoResizeImagesChange: (enabled: boolean) => void | Promise<void>;
	onBlockImagesChange: (blocked: boolean) => void | Promise<void>;
	onEnableSkillCommandsChange: (enabled: boolean) => void | Promise<void>;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void | Promise<void>;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void | Promise<void>;
	onTransportChange: (transport: Transport) => void | Promise<void>;
	onHttpIdleTimeoutMsChange: (timeoutMs: number) => void | Promise<void>;
	onCacheWarmingModeChange: (mode: CacheWarmingMode) => void | Promise<void>;
	onThemeChange: (theme: string) => void | Promise<void>;
	onUiAnimationsChange: (enabled: boolean) => void | Promise<void>;
	onAnimationIntensityChange: (intensity: AnimationIntensity) => void | Promise<void>;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void | Promise<void>;
	onMermaidRenderingModeChange: (mode: MermaidRenderingMode) => void | Promise<void>;
	onShowCacheMissNoticesChange: (shown: boolean) => void | Promise<void>;
	onCollapseChangelogChange: (collapsed: boolean) => void | Promise<void>;
	onEnableInstallTelemetryChange: (enabled: boolean) => void | Promise<void>;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void | Promise<void>;
	onTreeFilterModeChange: (
		mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all",
	) => void | Promise<void>;
	onToolPreviewLinesChange: (lines: 5 | 10 | 20) => void | Promise<void>;
	onShowHardwareCursorChange: (enabled: boolean) => void | Promise<void>;
	onEditorPaddingXChange: (padding: number) => void | Promise<void>;
	onOutputPadChange: (padding: 0 | 1) => void | Promise<void>;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void | Promise<void>;
	onQuietStartupChange: (enabled: boolean) => void | Promise<void>;
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void | Promise<void>;
	onClearOnShrinkChange: (enabled: boolean) => void | Promise<void>;
	onShowTerminalProgressChange: (enabled: boolean) => void | Promise<void>;
	onFullscreenExitOutputChange: (output: FullscreenExitOutput) => void | Promise<void>;
	onFullscreenScrollbarChange: (mode: ScrollViewScrollbar) => void | Promise<void>;
	onFullscreenCopyOnSelectChange: (enabled: boolean) => void | Promise<void>;
	onWarningsChange: (warnings: WarningSettings) => void | Promise<void>;
	onCancel: () => void;
}

/**
 * A submenu component for selecting from a list of options.
 */
class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: WarningSettings;

	constructor(
		warnings: WarningSettings,
		onChange: (warnings: WarningSettings) => void | Promise<void>,
		onCancel: () => void,
	) {
		super();

		this.state = { ...warnings };

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Anthropic extra usage",
				description: "Warn when Anthropic subscription auth may use paid extra usage",
				currentValue: (this.state.anthropicExtraUsage ?? true) ? "true" : "false",
				values: ["true", "false"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			async (id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage": {
						const warnings = { ...this.state, anthropicExtraUsage: newValue === "true" };
						await onChange(warnings);
						this.state = warnings;
						break;
					}
				}
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

function themeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	return availableThemes.map((name) => ({
		value: name,
		label: `${name === currentTheme ? "✓ " : "  "}${name}  ${themeSwatches(name)}`,
	}));
}

function themeSwatches(name: string): string {
	const colors = getResolvedThemeColors(name);
	const mode = getTerminalColorMode();
	return ["userMessageText", "text", "mdCode", "toolDiffAdded", "toolDiffRemoved", "accent"]
		.map((token) => `${foregroundAnsi(parseColor(colors[token]), mode)}●\x1b[0m`)
		.join(" ");
}

function themeSample(name: string, width: number): string[] {
	const colors = getResolvedThemeColors(name);
	const mode = getTerminalColorMode();
	const paint = (token: string, text: string): string =>
		`${foregroundAnsi(parseColor(colors[token]), mode)}${text}\x1b[0m`;
	return [
		paint("borderMuted", "─".repeat(Math.min(width, 36))),
		paint("editorPrompt", "◆ ") + paint("userMessageText", "Can you check this change?"),
		paint("text", "The updated line is ready."),
		paint("toolDiffRemoved", "- const oldValue = true;"),
		paint("toolDiffAdded", "+ const newValue = true;"),
	];
}

const AUTOMATIC_THEME_VALUE = "/";

function singleModeThemeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	return [
		{
			value: AUTOMATIC_THEME_VALUE,
			label: "  Automatic",
			description: "Use separate themes for light and dark terminal appearance",
		},
		...themeItems(availableThemes, currentTheme),
	];
}

function preferredTheme(availableThemes: string[], preferred: string | undefined, fallback: string): string {
	if (preferred && availableThemes.includes(preferred)) return preferred;
	if (availableThemes.includes(fallback)) return fallback;
	return availableThemes[0] ?? fallback;
}

function defaultAutomaticThemes(
	currentThemeSetting: string,
	availableThemes: string[],
): { lightTheme: string; darkTheme: string } {
	const autoTheme = parseAutoThemeSetting(currentThemeSetting);
	if (autoTheme) return autoTheme;

	const currentFixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
	const themeName = preferredTheme(availableThemes, currentFixedTheme, "dark");
	return { lightTheme: themeName, darkTheme: themeName };
}

class ThemeSubmenu extends Container {
	private inputComponent: (Component & { setAvailableHeight?(height: number): void }) | undefined;
	private availableHeight = 20;
	private readonly callbacks: SettingsCallbacks;
	private readonly availableThemes: string[];
	private readonly terminalTheme: TerminalTheme;
	private readonly onDone: (selectedValue?: string) => void | Promise<void>;
	private readonly originalThemeSetting: string;
	private menuComponent: Component | undefined;
	private mode: "single" | "automatic";
	private singleTheme: string;
	private lightTheme: string;
	private darkTheme: string;

	constructor(
		currentThemeSetting: string,
		terminalTheme: TerminalTheme,
		availableThemes: string[],
		callbacks: SettingsCallbacks,
		onDone: (selectedValue?: string) => void | Promise<void>,
	) {
		super();
		this.callbacks = callbacks;
		this.availableThemes = availableThemes;
		this.terminalTheme = terminalTheme;
		this.onDone = onDone;
		this.originalThemeSetting = currentThemeSetting;
		const autoTheme = parseAutoThemeSetting(currentThemeSetting);
		const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
		const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
		this.mode = autoTheme ? "automatic" : "single";
		this.lightTheme = automaticThemes.lightTheme;
		this.darkTheme = automaticThemes.darkTheme;
		this.singleTheme = preferredTheme(
			availableThemes,
			fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined),
			"dark",
		);

		if (this.mode === "automatic") {
			this.showAutomaticMenu();
		} else {
			this.showSingleMenu();
		}
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	setAvailableHeight(height: number): void {
		this.availableHeight = height;
		this.inputComponent?.setAvailableHeight?.(height - (this.mode === "automatic" ? 5 : 0));
	}

	private setContent(
		renderComponent: Component,
		inputComponent: Component & { setAvailableHeight?(height: number): void },
	): void {
		this.clear();
		this.menuComponent = renderComponent;
		this.addChild(renderComponent);
		this.inputComponent = inputComponent;
		this.setAvailableHeight(this.availableHeight);
	}

	private showSingleMenu(): void {
		this.mode = "single";
		const menu = new SelectSubmenu(
			"Theme",
			"Select a theme, or choose Automatic to follow terminal appearance.",
			singleModeThemeItems(this.availableThemes, this.singleTheme),
			this.singleTheme,
			(value) => {
				if (value === AUTOMATIC_THEME_VALUE) {
					this.mode = "automatic";
					this.callbacks.onThemePreview?.(this.getThemeSetting());
					this.showAutomaticMenu();
					return;
				}

				this.singleTheme = value;
				void this.apply(value);
			},
			() => this.cancel(),
			(value) => {
				this.callbacks.onThemePreview?.(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value);
			},
			{
				preview: (value, width) =>
					themeSample(value === AUTOMATIC_THEME_VALUE ? this.getActiveAutomaticTheme() : value, width),
			},
		);
		this.setContent(menu, menu);
	}

	private showAutomaticMenu(): void {
		this.mode = "automatic";
		const content = new Container();
		content.addChild(new Text(theme.bold(theme.fg("accent", "Automatic Theme")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(theme.fg("muted", "Choose themes for terminal light and dark appearance."), 0, 0));
		content.addChild(new Text(theme.fg("muted", "Light/dark detection requires terminal support."), 0, 0));
		content.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "light-theme",
				label: "Light theme",
				description: "Theme to use in automatic mode when the terminal is light",
				currentValue: this.lightTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Light Theme",
						"Select the theme to use for light terminal appearance",
						currentValue,
						done,
						(value) => {
							this.lightTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "dark-theme",
				label: "Dark theme",
				description: "Theme to use in automatic mode when the terminal is dark",
				currentValue: this.darkTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Dark Theme",
						"Select the theme to use for dark terminal appearance",
						currentValue,
						done,
						(value) => {
							this.darkTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "apply",
				label: "Apply",
				description: "Save and go back",
				currentValue: "save and go back",
				values: ["save and go back"],
			},
			{
				id: "single-mode",
				label: "Change mode",
				description: "Switch to one theme for light and dark",
				currentValue: "switch to single theme",
				values: ["switch to single theme"],
			},
		];

		const settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id) => {
				switch (id) {
					case "single-mode":
						this.mode = "single";
						this.singleTheme = this.getActiveAutomaticTheme();
						this.callbacks.onThemePreview?.(this.singleTheme);
						this.showSingleMenu();
						break;
					case "apply":
						void this.apply(this.getAutomaticThemeSetting());
						break;
				}
			},
			() => this.cancel(),
		);
		content.addChild(settingsList);
		this.setContent(content, settingsList);
	}

	private createThemeSelect(
		title: string,
		description: string,
		currentValue: string,
		done: (selectedValue?: string) => void,
		onSelect: (value: string) => void,
	): SelectSubmenu {
		return new SelectSubmenu(
			title,
			description,
			themeItems(this.availableThemes, currentValue),
			currentValue,
			onSelect,
			() => {
				this.callbacks.onThemePreview?.(this.getThemeSetting());
				done();
			},
			(value) => this.callbacks.onThemePreview?.(value),
			{ preview: (value, width) => themeSample(value, width) },
		);
	}

	private getThemeSetting(): string {
		return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
	}

	private getActiveAutomaticTheme(): string {
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	private getAutomaticThemeSetting(): string {
		return `${this.lightTheme}/${this.darkTheme}`;
	}

	private async apply(themeSetting: string): Promise<void> {
		try {
			await this.onDone(themeSetting);
		} catch (error) {
			this.clear();
			if (this.menuComponent) this.addChild(this.menuComponent);
			this.addChild(
				new Text(
					theme.fg("error", `Could not save theme: ${error instanceof Error ? error.message : String(error)}`),
					0,
					0,
				),
			);
		}
	}

	private cancel(): void {
		this.callbacks.onThemePreview?.(this.originalThemeSetting);
		this.onDone();
	}
}

export function createSettingsDefinition(
	config: SettingsConfig,
	callbacks: SettingsCallbacks,
): { items: SettingItem[]; onChange: SettingsListOnChange } {
	const supportsImages = getCapabilities().images;
	const followUpKey = keycap(keyDisplayText("app.message.followUp"));
	let currentWarnings = { ...config.warnings };

	const items: SettingItem[] = [
		{
			id: "autocompact",
			label: "Auto-compact",
			description: "Automatically compact context when it gets too large",
			currentValue: config.autoCompact ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "steering-mode",
			label: "Steering mode",
			description:
				"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
			currentValue: config.steeringMode,
			values: ["one-at-a-time", "all"],
		},
		{
			id: "follow-up-mode",
			label: "Follow-up mode",
			description: `${followUpKey} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
			currentValue: config.followUpMode,
			values: ["one-at-a-time", "all"],
		},
		{
			id: "default-thinking-level",
			label: "Default thinking level",
			description: "Default reasoning level for new model selections",
			currentValue: config.thinkingLevel,
			values: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		},
		{
			id: "transport",
			label: "Transport",
			description: "Preferred transport for providers that support multiple transports",
			currentValue: config.transport,
			values: ["sse", "websocket", "websocket-cached", "auto"],
		},
		{
			id: "http-idle-timeout",
			label: "HTTP idle timeout",
			description:
				"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
			currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
			values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
		},
		{
			id: "cache-warming-mode",
			label: "Cache warming",
			description: "off; streaming while the agent runs; idle also between runs while continuation stays profitable",
			currentValue: config.cacheWarmingMode,
			values: [...CACHE_WARMING_MODES],
		},
		{
			id: "hide-thinking",
			label: "Hide thinking",
			description: "Hide thinking blocks in assistant responses",
			currentValue: config.hideThinkingBlock ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "tool-preview-lines",
			label: "Tool preview lines",
			description: "Visible lines for edit, write and shell activity before expanding",
			currentValue: String(config.toolPreviewLines),
			values: ["5", "10", "20"],
		},
		{
			id: "mermaid-rendering",
			label: "Mermaid diagrams",
			description: "Render Mermaid code blocks as Unicode diagrams",
			currentValue: config.mermaidRenderingMode,
			values: ["off", "final", "streaming"],
		},
		{
			id: "cache-miss-notices",
			label: "Cache miss notices",
			description: "Show transcript notices for cache costs and provider recovery diagnostics",
			currentValue: config.showCacheMissNotices ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "collapse-changelog",
			label: "Collapse changelog",
			description: "Show condensed changelog after updates",
			currentValue: config.collapseChangelog ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "quiet-startup",
			label: "Quiet startup",
			description: "Disable verbose printing at startup",
			currentValue: config.quietStartup ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "install-telemetry",
			label: "Provider attribution",
			description: "Attach candy attribution headers to requests for OpenRouter, NVIDIA NIM, and Cloudflare",
			currentValue: config.enableInstallTelemetry ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "default-project-trust",
			label: "Default project trust",
			description: "Fallback behavior when no extension or saved trust decision decides project trust",
			currentValue: DEFAULT_PROJECT_TRUST_LABELS[config.defaultProjectTrust],
			values: Object.values(DEFAULT_PROJECT_TRUST_LABELS),
		},
		{
			id: "double-escape-action",
			label: "Double-escape action",
			description: "Action when pressing Escape twice with empty editor",
			currentValue: config.doubleEscapeAction,
			values: ["tree", "fork", "none"],
		},
		{
			id: "tree-filter-mode",
			label: "Tree filter mode",
			description: "Default filter when opening the conversation tree",
			currentValue: config.treeFilterMode,
			values: ["default", "no-tools", "user-only", "labeled-only", "all"],
		},
		{
			id: "warnings",
			label: "Warnings",
			description: "Enable or disable individual warnings",
			currentValue: "configure",
			submenu: (_currentValue, done) =>
				new WarningSettingsSubmenu(
					currentWarnings,
					async (warnings) => {
						await callbacks.onWarningsChange(warnings);
						currentWarnings = warnings;
					},
					() => done(),
				),
		},
		{
			id: "fullscreen-exit-output",
			label: "Fullscreen exit output",
			description: "Print the transcript or only a session resume hint when exiting",
			currentValue: config.fullscreenExitOutput,
			values: ["transcript", "resume-hint"],
		},
		{
			id: "fullscreen-scrollbar",
			label: "Fullscreen scrollbar",
			description: "Scrollbar behavior for the transcript view",
			currentValue: config.fullscreenScrollbar,
			values: ["auto", "always", "hidden"],
		},
		{
			id: "fullscreen-copy-on-select",
			label: "Fullscreen copy on select",
			description: `Automatically copy selected text; disable to copy selections with ${keycap(keyDisplayText("app.message.copy"))}`,
			currentValue: config.fullscreenCopyOnSelect ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "theme",
			label: "Theme",
			description: "Color theme for the interface",
			currentValue: config.currentTheme,
			submenu: (currentValue, done) =>
				new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done),
		},
		{
			id: "ui-animations",
			label: "UI animations",
			description: "Animate interface transitions and the input border",
			currentValue: config.uiAnimations ? "true" : "false",
			values: ["true", "false"],
		},
		{
			id: "animation-intensity",
			label: "Animation intensity",
			description: "Motion speed and update frequency",
			currentValue: config.animationIntensity,
			values: ["conservative", "moderate", "aggressive"],
		},
	];

	// Only show image toggle if terminal supports it
	if (supportsImages) {
		// Insert after autocompact
		items.splice(1, 0, {
			id: "show-images",
			label: "Show images",
			description: "Render images inline in terminal",
			currentValue: config.showImages ? "true" : "false",
			values: ["true", "false"],
		});
		items.splice(2, 0, {
			id: "image-width-cells",
			label: "Image width",
			description: "Preferred inline image width in terminal cells",
			currentValue: String(config.imageWidthCells),
			values: ["60", "80", "120"],
		});
	}

	// Image auto-resize toggle (always available, affects both attached and read images)
	items.splice(supportsImages ? 3 : 1, 0, {
		id: "auto-resize-images",
		label: "Auto-resize images",
		description: "Resize large images to 2000x2000 max for better model compatibility",
		currentValue: config.autoResizeImages ? "true" : "false",
		values: ["true", "false"],
	});

	// Block images toggle (always available, insert after auto-resize-images)
	const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
	items.splice(autoResizeIndex + 1, 0, {
		id: "block-images",
		label: "Block images",
		description: "Prevent images from being sent to LLM providers",
		currentValue: config.blockImages ? "true" : "false",
		values: ["true", "false"],
	});

	// Skill commands toggle (insert after block-images)
	const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
	items.splice(blockImagesIndex + 1, 0, {
		id: "skill-commands",
		label: "Skill commands",
		description: "Show skills in Command",
		currentValue: config.enableSkillCommands ? "true" : "false",
		values: ["true", "false"],
	});

	// Hardware cursor toggle (insert after skill-commands)
	const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
	items.splice(skillCommandsIndex + 1, 0, {
		id: "show-hardware-cursor",
		label: "Show hardware cursor",
		description: "Show the terminal cursor while still positioning it for IME support",
		currentValue: config.showHardwareCursor ? "true" : "false",
		values: ["true", "false"],
	});

	// Editor padding toggle (insert after show-hardware-cursor)
	const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
	items.splice(hardwareCursorIndex + 1, 0, {
		id: "editor-padding",
		label: "Editor padding",
		description: "Horizontal padding for input editor (0-3)",
		currentValue: String(config.editorPaddingX),
		values: ["0", "1", "2", "3"],
	});

	// Output padding toggle (insert after editor-padding)
	const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
	items.splice(editorPaddingIndex + 1, 0, {
		id: "output-padding",
		label: "Output padding",
		description: "Horizontal padding for user messages, assistant messages, and thinking",
		currentValue: String(config.outputPad),
		values: ["0", "1"],
	});

	// Autocomplete max visible toggle (insert after output-padding)
	const outputPaddingIndex = items.findIndex((item) => item.id === "output-padding");
	items.splice(outputPaddingIndex + 1, 0, {
		id: "autocomplete-max-visible",
		label: "Autocomplete max items",
		description: "Max visible items in autocomplete dropdown (3-20)",
		currentValue: String(config.autocompleteMaxVisible),
		values: ["3", "5", "7", "10", "15", "20"],
	});

	// Clear on shrink toggle (insert after autocomplete-max-visible)
	const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
	items.splice(autocompleteIndex + 1, 0, {
		id: "clear-on-shrink",
		label: "Clear on shrink",
		description: "Clear empty rows when content shrinks (may cause flicker)",
		currentValue: config.clearOnShrink ? "true" : "false",
		values: ["true", "false"],
	});

	// Terminal progress toggle (insert after clear-on-shrink)
	const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
	items.splice(clearOnShrinkIndex + 1, 0, {
		id: "terminal-progress",
		label: "Terminal progress",
		description: "Show OSC 9;4 progress indicators in the terminal tab bar",
		currentValue: config.showTerminalProgress ? "true" : "false",
		values: ["true", "false"],
	});

	const onSettingChange: SettingsListOnChange = async (id, newValue) => {
		switch (id) {
			case "default-thinking-level":
				await callbacks.onDefaultThinkingLevelChange(newValue as ThinkingLevel);
				break;
			case "autocompact":
				await callbacks.onAutoCompactChange(newValue === "true");
				break;
			case "show-images":
				await callbacks.onShowImagesChange(newValue === "true");
				break;
			case "image-width-cells":
				await callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
				break;
			case "auto-resize-images":
				await callbacks.onAutoResizeImagesChange(newValue === "true");
				break;
			case "block-images":
				await callbacks.onBlockImagesChange(newValue === "true");
				break;
			case "skill-commands":
				await callbacks.onEnableSkillCommandsChange(newValue === "true");
				break;
			case "steering-mode":
				await callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
				break;
			case "follow-up-mode":
				await callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
				break;
			case "transport":
				await callbacks.onTransportChange(newValue as Transport);
				break;
			case "http-idle-timeout": {
				const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
				if (choice) {
					await callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
				}
				break;
			}
			case "cache-warming-mode":
				await callbacks.onCacheWarmingModeChange(newValue as CacheWarmingMode);
				break;
			case "hide-thinking":
				await callbacks.onHideThinkingBlockChange(newValue === "true");
				break;
			case "tool-preview-lines":
				await callbacks.onToolPreviewLinesChange(Number(newValue) as 5 | 10 | 20);
				break;
			case "mermaid-rendering":
				await callbacks.onMermaidRenderingModeChange(newValue as MermaidRenderingMode);
				break;
			case "cache-miss-notices":
				await callbacks.onShowCacheMissNoticesChange(newValue === "true");
				break;
			case "collapse-changelog":
				await callbacks.onCollapseChangelogChange(newValue === "true");
				break;
			case "quiet-startup":
				await callbacks.onQuietStartupChange(newValue === "true");
				break;
			case "install-telemetry":
				await callbacks.onEnableInstallTelemetryChange(newValue === "true");
				break;
			case "default-project-trust": {
				const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
				if (defaultProjectTrust) {
					await callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
				}
				break;
			}
			case "double-escape-action":
				await callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree");
				break;
			case "tree-filter-mode":
				await callbacks.onTreeFilterModeChange(
					newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
				);
				break;
			case "show-hardware-cursor":
				await callbacks.onShowHardwareCursorChange(newValue === "true");
				break;
			case "editor-padding":
				await callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
				break;
			case "output-padding":
				await callbacks.onOutputPadChange(newValue === "0" ? 0 : 1);
				break;
			case "autocomplete-max-visible":
				await callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
				break;
			case "clear-on-shrink":
				await callbacks.onClearOnShrinkChange(newValue === "true");
				break;
			case "terminal-progress":
				await callbacks.onShowTerminalProgressChange(newValue === "true");
				break;
			case "fullscreen-exit-output":
				await callbacks.onFullscreenExitOutputChange(newValue as FullscreenExitOutput);
				break;
			case "fullscreen-scrollbar":
				await callbacks.onFullscreenScrollbarChange(newValue as ScrollViewScrollbar);
				break;
			case "fullscreen-copy-on-select":
				await callbacks.onFullscreenCopyOnSelectChange(newValue === "true");
				break;
			case "theme":
				return callbacks.onThemeChange(newValue);
			case "ui-animations":
				await callbacks.onUiAnimationsChange(newValue === "true");
				break;
			case "animation-intensity":
				await callbacks.onAnimationIntensityChange(newValue as AnimationIntensity);
				break;
		}
	};
	return { items, onChange: onSettingChange };
}

export function cycleSetting(
	definition: ReturnType<typeof createSettingsDefinition>,
	id: string,
	direction: 1 | -1,
): Promise<void> {
	const item = definition.items.find((candidate) => candidate.id === id);
	if (!item?.values?.length) return Promise.resolve();
	const currentIndex = item.values.indexOf(item.currentValue);
	const nextIndex = (currentIndex + direction + item.values.length) % item.values.length;
	const value = item.values[nextIndex];
	if (value === undefined) return Promise.resolve();
	return Promise.resolve()
		.then(() => definition.onChange(item.id, value))
		.then(() => {
			item.currentValue = value;
		});
}
