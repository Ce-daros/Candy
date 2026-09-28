import type { ThinkingLevel } from "@candy/agent-core";
import type { Transport } from "@candy/ai";
import {
	type Component,
	Container,
	type Focusable,
	foregroundAnsi,
	fuzzyFilter,
	getCapabilities,
	getKeybindings,
	getTerminalColorMode,
	Input,
	parseColor,
	type ScrollViewScrollbar,
	type SelectItem,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
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
import { keycap, keyDisplayText, keyHint } from "./keybinding-hints.ts";
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
	onAutoCompactChange: (enabled: boolean) => void;
	onDefaultThinkingLevelChange: (level: ThinkingLevel) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onImageWidthCellsChange: (width: number) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onHttpIdleTimeoutMsChange: (timeoutMs: number) => void;
	onCacheWarmingModeChange: (mode: CacheWarmingMode) => void;
	onThemeChange: (theme: string) => void;
	onUiAnimationsChange: (enabled: boolean) => void;
	onAnimationIntensityChange: (intensity: AnimationIntensity) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onMermaidRenderingModeChange: (mode: MermaidRenderingMode) => void;
	onShowCacheMissNoticesChange: (shown: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onEnableInstallTelemetryChange: (enabled: boolean) => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onToolPreviewLinesChange: (lines: 5 | 10 | 20) => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onOutputPadChange: (padding: 0 | 1) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onFullscreenExitOutputChange: (output: FullscreenExitOutput) => void;
	onFullscreenScrollbarChange: (mode: ScrollViewScrollbar) => void;
	onFullscreenCopyOnSelectChange: (enabled: boolean) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
	onCancel: () => void;
}

/**
 * A submenu component for selecting from a list of options.
 */
class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
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
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: newValue === "true" };
						onChange({ ...this.state });
						break;
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
	private readonly onDone: (selectedValue?: string) => void;
	private readonly originalThemeSetting: string;
	private mode: "single" | "automatic";
	private singleTheme: string;
	private lightTheme: string;
	private darkTheme: string;

	constructor(
		currentThemeSetting: string,
		terminalTheme: TerminalTheme,
		availableThemes: string[],
		callbacks: SettingsCallbacks,
		onDone: (selectedValue?: string) => void,
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
				this.apply(value);
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
						this.apply(this.getAutomaticThemeSetting());
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

	private apply(themeSetting: string): void {
		this.onDone(themeSetting);
	}

	private cancel(): void {
		this.callbacks.onThemePreview?.(this.originalThemeSetting);
		this.onDone();
	}
}

export function createSettingsDefinition(
	config: SettingsConfig,
	callbacks: SettingsCallbacks,
): { items: SettingItem[]; onChange: (id: string, newValue: string) => void } {
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
			label: "Install telemetry",
			description: "Send an anonymous version/update ping after changelog-detected updates",
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
					(warnings) => {
						currentWarnings = warnings;
						callbacks.onWarningsChange(warnings);
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

	const onSettingChange = (id: string, newValue: string): void => {
		switch (id) {
			case "default-thinking-level":
				callbacks.onDefaultThinkingLevelChange(newValue as ThinkingLevel);
				break;
			case "autocompact":
				callbacks.onAutoCompactChange(newValue === "true");
				break;
			case "show-images":
				callbacks.onShowImagesChange(newValue === "true");
				break;
			case "image-width-cells":
				callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
				break;
			case "auto-resize-images":
				callbacks.onAutoResizeImagesChange(newValue === "true");
				break;
			case "block-images":
				callbacks.onBlockImagesChange(newValue === "true");
				break;
			case "skill-commands":
				callbacks.onEnableSkillCommandsChange(newValue === "true");
				break;
			case "steering-mode":
				callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
				break;
			case "follow-up-mode":
				callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
				break;
			case "transport":
				callbacks.onTransportChange(newValue as Transport);
				break;
			case "http-idle-timeout": {
				const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
				if (choice) {
					callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
				}
				break;
			}
			case "cache-warming-mode":
				callbacks.onCacheWarmingModeChange(newValue as CacheWarmingMode);
				break;
			case "hide-thinking":
				callbacks.onHideThinkingBlockChange(newValue === "true");
				break;
			case "tool-preview-lines":
				callbacks.onToolPreviewLinesChange(Number(newValue) as 5 | 10 | 20);
				break;
			case "mermaid-rendering":
				callbacks.onMermaidRenderingModeChange(newValue as MermaidRenderingMode);
				break;
			case "cache-miss-notices":
				callbacks.onShowCacheMissNoticesChange(newValue === "true");
				break;
			case "collapse-changelog":
				callbacks.onCollapseChangelogChange(newValue === "true");
				break;
			case "quiet-startup":
				callbacks.onQuietStartupChange(newValue === "true");
				break;
			case "install-telemetry":
				callbacks.onEnableInstallTelemetryChange(newValue === "true");
				break;
			case "default-project-trust": {
				const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
				if (defaultProjectTrust) {
					callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
				}
				break;
			}
			case "double-escape-action":
				callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree");
				break;
			case "tree-filter-mode":
				callbacks.onTreeFilterModeChange(newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all");
				break;
			case "show-hardware-cursor":
				callbacks.onShowHardwareCursorChange(newValue === "true");
				break;
			case "editor-padding":
				callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
				break;
			case "output-padding":
				callbacks.onOutputPadChange(newValue === "0" ? 0 : 1);
				break;
			case "autocomplete-max-visible":
				callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
				break;
			case "clear-on-shrink":
				callbacks.onClearOnShrinkChange(newValue === "true");
				break;
			case "terminal-progress":
				callbacks.onShowTerminalProgressChange(newValue === "true");
				break;
			case "fullscreen-exit-output":
				callbacks.onFullscreenExitOutputChange(newValue as FullscreenExitOutput);
				break;
			case "fullscreen-scrollbar":
				callbacks.onFullscreenScrollbarChange(newValue as ScrollViewScrollbar);
				break;
			case "fullscreen-copy-on-select":
				callbacks.onFullscreenCopyOnSelectChange(newValue === "true");
				break;
			case "theme":
				callbacks.onThemeChange(newValue);
				break;
			case "ui-animations":
				callbacks.onUiAnimationsChange(newValue === "true");
				break;
			case "animation-intensity":
				callbacks.onAnimationIntensityChange(newValue as AnimationIntensity);
				break;
		}
	};
	return { items, onChange: onSettingChange };
}

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent implements Focusable {
	invalidate(): void {}
	private settingsList: SettingsList;
	private readonly categoryLists: SettingsList[] = [];
	private readonly searchInput = new Input({ prompt: "Search  " });
	private readonly categories = [
		"Appearance",
		"Conversation & Input",
		"Models & Connection",
		"Privacy & Trust",
		"Terminal",
	];
	private readonly allItems: SettingItem[];
	private readonly onSettingChange: (id: string, newValue: string) => void;
	private selectedCategory = 0;
	private region: "categories" | "settings" | "search" = "settings";
	private searchList?: SettingsList;
	private availableHeight = 20;
	private readonly onCancel: () => void;
	private _focused = false;
	private lastCategoryWidth = 0;
	private lastListStart = 0;
	private lastSearchRow = 0;
	private lastWide = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.region === "search";
	}

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		this.onCancel = callbacks.onCancel;

		const { items, onChange } = createSettingsDefinition(config, callbacks);
		this.allItems = items;
		this.onSettingChange = onChange;
		this.settingsList = new SettingsList(items, 10, getSettingsListTheme(), onChange, callbacks.onCancel, {
			enableSearch: true,
		});

		const categoryIds = [
			[
				"theme",
				"ui-animations",
				"animation-intensity",
				"editor-padding",
				"output-padding",
				"show-images",
				"image-width-cells",
				"mermaid-rendering",
				"collapse-changelog",
				"quiet-startup",
				"warnings",
			],
			[
				"hide-thinking",
				"tool-preview-lines",
				"autocompact",
				"steering-mode",
				"follow-up-mode",
				"autocomplete-max-visible",
				"skill-commands",
				"double-escape-action",
				"tree-filter-mode",
			],
			["default-thinking-level", "transport", "http-idle-timeout", "cache-warming-mode", "cache-miss-notices"],
			["install-telemetry", "default-project-trust", "block-images", "auto-resize-images"],
			[
				"show-hardware-cursor",
				"fullscreen-scrollbar",
				"fullscreen-copy-on-select",
				"fullscreen-exit-output",
				"clear-on-shrink",
				"terminal-progress",
			],
		];
		for (const ids of categoryIds) {
			this.categoryLists.push(
				new SettingsList(
					ids.flatMap((id) => items.filter((item) => item.id === id)),
					10,
					getSettingsListTheme(),
					onChange,
					callbacks.onCancel,
				),
			);
		}
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}

	getSettingItems(): readonly SettingItem[] {
		return [...this.allItems];
	}

	cycleSetting(id: string, direction: 1 | -1): void {
		const item = this.allItems.find((candidate) => candidate.id === id);
		if (!item?.values?.length) return;
		const currentIndex = item.values.indexOf(item.currentValue);
		const nextIndex = (currentIndex + direction + item.values.length) % item.values.length;
		const value = item.values[nextIndex];
		if (value === undefined) return;
		item.currentValue = value;
		this.onSettingChange(item.id, value);
	}

	createSettingControl(id: string, onCancel: () => void): Component {
		const item = this.allItems.find((candidate) => candidate.id === id);
		if (!item) throw new Error(`Unknown setting: ${id}`);
		return new SettingsList([item], 1, getSettingsListTheme(), this.onSettingChange, onCancel);
	}

	setAvailableHeight(height: number): void {
		this.availableHeight = Math.max(8, height);
	}

	private getActiveList(): SettingsList {
		return this.searchList ?? this.categoryLists[this.selectedCategory];
	}

	private updateSearch(): void {
		const query = this.searchInput.getValue();
		this.searchList = query
			? new SettingsList(
					fuzzyFilter(this.allItems, query, (item) => `${item.label} ${item.description ?? ""}`),
					10,
					getSettingsListTheme(),
					this.onSettingChange,
					this.onCancel,
				)
			: undefined;
	}

	render(width: number): string[] {
		const wide = width >= 100;
		const categoryWidth = wide ? Math.min(26, Math.floor(width * 0.25)) : width;
		this.lastWide = wide;
		this.lastCategoryWidth = categoryWidth;
		this.lastListStart = wide ? 2 : 4;
		const mainWidth = wide ? width - categoryWidth - 3 : width;
		const list = this.getActiveList();
		if (list.isSubmenuOpen()) {
			list.setAvailableHeight(this.availableHeight);
			return list.render(width).slice(0, this.availableHeight);
		}
		const searchLines = this.searchInput.render(width);
		const bodyHeight = Math.max(3, this.availableHeight - (wide ? 2 : 4) - 1 - searchLines.length - 1);
		list.setMaxVisible(Math.max(2, bodyHeight - 4));
		list.setAvailableHeight(bodyHeight);
		const mainLines = list.render(mainWidth).slice(0, bodyHeight);
		const lines = [theme.bold(theme.fg("accent", "Settings")), ""];
		const categoryLine = (index: number): string => {
			const selected = index === this.selectedCategory && !this.searchList;
			const focused = selected && this.region === "categories";
			const name = focused
				? theme.bold(theme.fg("accent", this.categories[index]))
				: selected
					? theme.fg("accent", this.categories[index])
					: theme.fg("muted", this.categories[index]);
			const label = `${selected ? theme.fg("borderAccent", "♦ ") : "  "}${name}${selected ? theme.fg("borderAccent", " ♦") : ""}`;
			return truncateToWidth(label, categoryWidth);
		};
		if (wide) {
			const contentHeight = Math.min(bodyHeight, Math.max(this.categories.length, mainLines.length));
			for (let row = 0; row < contentHeight; row++) {
				const left = row < this.categories.length ? categoryLine(row) : "";
				lines.push(
					`${left}${" ".repeat(Math.max(0, categoryWidth - visibleWidth(left)))} ${theme.fg("borderMuted", "│")} ${mainLines[row] ?? ""}`,
				);
			}
		} else {
			let firstCategory = Math.max(0, this.selectedCategory - 1);
			let categoryStrip = "";
			for (let index = firstCategory; index < this.categories.length; index++) {
				const candidate = `${categoryStrip}${categoryStrip ? "  " : ""}${categoryLine(index)}`;
				if (visibleWidth(candidate) > width && index > this.selectedCategory) break;
				if (visibleWidth(candidate) > width) {
					firstCategory = this.selectedCategory;
					categoryStrip = categoryLine(index);
				} else categoryStrip = candidate;
			}
			lines.push(truncateToWidth(`${firstCategory > 0 ? theme.fg("muted", "‹ ") : ""}${categoryStrip}`, width));
			lines.push(theme.fg("borderMuted", "─".repeat(width)));
			lines.push(...mainLines);
		}
		lines.push(theme.fg("borderMuted", "─".repeat(width)));
		this.lastSearchRow = lines.length;
		lines.push(...searchLines);
		lines.push(
			`${keyHint("app.panel.focusNext", "panels")} · ${keyHint("tui.select.confirm", "select")} · ${keyHint("tui.select.cancel", "back")}`,
		);
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "press" && event.type !== "click" && event.type !== "wheel") return undefined;
		const list = this.getActiveList();
		if (list.isSubmenuOpen()) return list.handleMouse(event);
		if (event.y === this.lastSearchRow) {
			this.region = "search";
			this.searchInput.focused = this._focused;
			return this.searchInput.handleMouse?.({ ...event, y: 0 });
		}
		if (this.lastWide && event.x < this.lastCategoryWidth && event.y >= 2 && event.y < 2 + this.categories.length) {
			this.selectedCategory = event.y - 2;
			this.region = "categories";
			this.searchInput.setValue("");
			this.searchList = undefined;
			return { handled: true, focus: true, render: true };
		}
		if (
			event.y >= this.lastListStart &&
			event.y < this.lastSearchRow - 1 &&
			(!this.lastWide || event.x > this.lastCategoryWidth + 1)
		) {
			this.region = "settings";
			return list.handleMouse({
				...event,
				x: this.lastWide ? event.x - this.lastCategoryWidth - 3 : event.x,
				y: event.y - this.lastListStart,
			});
		}
		return undefined;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const list = this.getActiveList();
		if (list.isSubmenuOpen()) {
			list.handleInput(data);
			return;
		}
		if (kb.matches(data, "app.panel.focusNext") || kb.matches(data, "app.panel.focusPrevious")) {
			const regions = ["settings", "categories", "search"] as const;
			const delta = kb.matches(data, "app.panel.focusNext") ? 1 : -1;
			this.region = regions[(regions.indexOf(this.region) + delta + regions.length) % regions.length];
			this.searchInput.focused = this._focused && this.region === "search";
		} else if (
			this.region === "categories" &&
			(kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down"))
		) {
			const delta = kb.matches(data, "tui.select.down") ? 1 : -1;
			this.selectedCategory = (this.selectedCategory + delta + this.categories.length) % this.categories.length;
			this.searchInput.setValue("");
			this.searchList = undefined;
		} else if (this.region === "categories" && kb.matches(data, "tui.select.confirm")) {
			this.region = "settings";
		} else if (kb.matches(data, "tui.select.cancel")) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.searchList = undefined;
			} else this.onCancel();
		} else if (
			this.region !== "categories" &&
			(kb.matches(data, "tui.select.up") ||
				kb.matches(data, "tui.select.down") ||
				kb.matches(data, "tui.select.confirm") ||
				(data === " " && this.region === "settings"))
		) {
			list.handleInput(data);
		} else {
			this.region = "search";
			this.searchInput.focused = this._focused;
			this.searchInput.handleInput(data);
			this.updateSearch();
		}
	}
}
