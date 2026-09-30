import {
	type Component,
	Container,
	foregroundAnsi,
	getCapabilities,
	getTerminalColorMode,
	parseColor,
	type SelectItem,
	type SettingItem,
	SettingsList,
	type SettingsListOnChange,
	Spacer,
	Text,
} from "@candy/tui";
import { HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import type { InteractiveSettingId, InteractiveSettingValue } from "../../../core/interactive-setting-values.ts";
import {
	getInteractiveSettingValueStrings,
	parseInteractiveSettingValue,
} from "../../../core/interactive-setting-values.ts";
import type { DefaultProjectTrust, SettingsManager } from "../../../core/settings-manager.ts";
import { getInteractiveSettingState, isInteractiveSettingId } from "../../../core/settings-operations.ts";
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

function currentSettingValue(settings: SettingsManager, id: InteractiveSettingId): string {
	return String(getInteractiveSettingState(settings, id).value);
}

export interface SettingsContext {
	currentTheme: string;
	terminalTheme: TerminalTheme;
	availableThemes: readonly string[];
}

export interface SettingsCallbacks {
	onInteractiveSettingChange: (
		id: InteractiveSettingId,
		value: InteractiveSettingValue<InteractiveSettingId>,
	) => void | Promise<void>;
	onThemeChange: (theme: string) => void | Promise<void>;
	onThemePreview?: (theme: string) => void;
	onCancel: () => void;
}

/**
 * A submenu component for selecting from a list of options.
 */
class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: boolean;

	constructor(enabled: boolean, onChange: (enabled: boolean) => void | Promise<void>, onCancel: () => void) {
		super();

		this.state = enabled;

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Anthropic extra usage",
				description: "Warn when Anthropic subscription auth may use paid extra usage",
				currentValue: String(this.state),
				values: getInteractiveSettingValueStrings("anthropic-extra-usage"),
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			async (id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage": {
						const enabled = parseInteractiveSettingValue("anthropic-extra-usage", newValue);
						await onChange(enabled);
						this.state = enabled;
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

function themeItems(availableThemes: readonly string[], currentTheme: string): SelectItem[] {
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

function singleModeThemeItems(availableThemes: readonly string[], currentTheme: string): SelectItem[] {
	return [
		{
			value: AUTOMATIC_THEME_VALUE,
			label: "  Automatic",
			description: "Use separate themes for light and dark terminal appearance",
		},
		...themeItems(availableThemes, currentTheme),
	];
}

function preferredTheme(availableThemes: readonly string[], preferred: string | undefined, fallback: string): string {
	if (preferred && availableThemes.includes(preferred)) return preferred;
	if (availableThemes.includes(fallback)) return fallback;
	return availableThemes[0] ?? fallback;
}

function defaultAutomaticThemes(
	currentThemeSetting: string,
	availableThemes: readonly string[],
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
	private readonly availableThemes: readonly string[];
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
		availableThemes: readonly string[],
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
	settings: SettingsManager,
	context: SettingsContext,
	callbacks: SettingsCallbacks,
): { items: SettingItem[]; onChange: SettingsListOnChange } {
	const supportsImages = getCapabilities().images;
	const followUpKey = keycap(keyDisplayText("app.message.followUp"));
	const items: SettingItem[] = [
		{
			id: "autocompact",
			label: "Auto-compact",
			description: "Automatically compact context when it gets too large",
			currentValue: currentSettingValue(settings, "autocompact"),
			values: getInteractiveSettingValueStrings("autocompact"),
		},
		{
			id: "steering-mode",
			label: "Steering mode",
			description:
				"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
			currentValue: currentSettingValue(settings, "steering-mode"),
			values: getInteractiveSettingValueStrings("steering-mode"),
		},
		{
			id: "follow-up-mode",
			label: "Follow-up mode",
			description: `${followUpKey} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
			currentValue: currentSettingValue(settings, "follow-up-mode"),
			values: getInteractiveSettingValueStrings("follow-up-mode"),
		},
		{
			id: "default-thinking-level",
			label: "Default thinking level",
			description: "Default reasoning level for new model selections",
			currentValue: currentSettingValue(settings, "default-thinking-level"),
			values: getInteractiveSettingValueStrings("default-thinking-level"),
		},
		{
			id: "transport",
			label: "Transport",
			description: "Preferred transport for providers that support multiple transports",
			currentValue: currentSettingValue(settings, "transport"),
			values: getInteractiveSettingValueStrings("transport"),
		},
		{
			id: "http-idle-timeout",
			label: "HTTP idle timeout",
			description:
				"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
			currentValue: currentSettingValue(settings, "http-idle-timeout"),
			values: getInteractiveSettingValueStrings("http-idle-timeout"),
			optionLabels: Object.fromEntries(
				HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => [String(choice.timeoutMs), choice.label]),
			),
		},
		{
			id: "cache-warming-mode",
			label: "Cache warming",
			description: "off; streaming while the agent runs; idle also between runs while continuation stays profitable",
			currentValue: currentSettingValue(settings, "cache-warming-mode"),
			values: getInteractiveSettingValueStrings("cache-warming-mode"),
		},
		{
			id: "hide-thinking",
			label: "Hide thinking",
			description: "Hide thinking blocks in assistant responses",
			currentValue: currentSettingValue(settings, "hide-thinking"),
			values: getInteractiveSettingValueStrings("hide-thinking"),
		},
		{
			id: "tool-preview-lines",
			label: "Tool preview lines",
			description: "Visible lines for edit, write and shell activity before expanding",
			currentValue: currentSettingValue(settings, "tool-preview-lines"),
			values: getInteractiveSettingValueStrings("tool-preview-lines"),
		},
		{
			id: "mermaid-rendering",
			label: "Mermaid diagrams",
			description: "Render Mermaid code blocks as Unicode diagrams",
			currentValue: currentSettingValue(settings, "mermaid-rendering"),
			values: getInteractiveSettingValueStrings("mermaid-rendering"),
		},
		{
			id: "cache-miss-notices",
			label: "Cache miss notices",
			description: "Show transcript notices for cache costs and provider recovery diagnostics",
			currentValue: currentSettingValue(settings, "cache-miss-notices"),
			values: getInteractiveSettingValueStrings("cache-miss-notices"),
		},
		{
			id: "collapse-changelog",
			label: "Collapse changelog",
			description: "Show condensed changelog after updates",
			currentValue: currentSettingValue(settings, "collapse-changelog"),
			values: getInteractiveSettingValueStrings("collapse-changelog"),
		},
		{
			id: "quiet-startup",
			label: "Quiet startup",
			description: "Disable verbose printing at startup",
			currentValue: currentSettingValue(settings, "quiet-startup"),
			values: getInteractiveSettingValueStrings("quiet-startup"),
		},
		{
			id: "install-telemetry",
			label: "Provider attribution",
			description: "Attach candy attribution headers to requests for OpenRouter, NVIDIA NIM, and Cloudflare",
			currentValue: currentSettingValue(settings, "install-telemetry"),
			values: getInteractiveSettingValueStrings("install-telemetry"),
		},
		{
			id: "default-project-trust",
			label: "Default project trust",
			description: "Fallback behavior when no extension or saved trust decision decides project trust",
			currentValue: currentSettingValue(settings, "default-project-trust"),
			values: getInteractiveSettingValueStrings("default-project-trust"),
			optionLabels: DEFAULT_PROJECT_TRUST_LABELS,
		},
		{
			id: "double-escape-action",
			label: "Double-escape action",
			description: "Action when pressing Escape twice with empty editor",
			currentValue: currentSettingValue(settings, "double-escape-action"),
			values: getInteractiveSettingValueStrings("double-escape-action"),
		},
		{
			id: "tree-filter-mode",
			label: "Tree filter mode",
			description: "Default filter when opening the conversation tree",
			currentValue: currentSettingValue(settings, "tree-filter-mode"),
			values: getInteractiveSettingValueStrings("tree-filter-mode"),
		},
		{
			id: "warnings",
			label: "Warnings",
			description: "Enable or disable individual warnings",
			currentValue: "configure",
			submenu: (_currentValue, done) =>
				new WarningSettingsSubmenu(
					parseInteractiveSettingValue(
						"anthropic-extra-usage",
						currentSettingValue(settings, "anthropic-extra-usage"),
					),
					(enabled) => callbacks.onInteractiveSettingChange("anthropic-extra-usage", enabled),
					() => done(),
				),
		},
		{
			id: "fullscreen-exit-output",
			label: "Fullscreen exit output",
			description: "Print the transcript or only a session resume hint when exiting",
			currentValue: currentSettingValue(settings, "fullscreen-exit-output"),
			values: getInteractiveSettingValueStrings("fullscreen-exit-output"),
		},
		{
			id: "fullscreen-scrollbar",
			label: "Fullscreen scrollbar",
			description: "Scrollbar behavior for the transcript view",
			currentValue: currentSettingValue(settings, "fullscreen-scrollbar"),
			values: getInteractiveSettingValueStrings("fullscreen-scrollbar"),
		},
		{
			id: "fullscreen-copy-on-select",
			label: "Fullscreen copy on select",
			description: `Automatically copy selected text; disable to copy selections with ${keycap(keyDisplayText("app.message.copy"))}`,
			currentValue: currentSettingValue(settings, "fullscreen-copy-on-select"),
			values: getInteractiveSettingValueStrings("fullscreen-copy-on-select"),
		},
		{
			id: "theme",
			label: "Theme",
			description: "Color theme for the interface",
			currentValue: context.currentTheme,
			submenu: (currentValue, done) =>
				new ThemeSubmenu(currentValue, context.terminalTheme, context.availableThemes, callbacks, done),
		},
		{
			id: "ui-animations",
			label: "UI animations",
			description: "Animate interface transitions and the input border",
			currentValue: currentSettingValue(settings, "ui-animations"),
			values: getInteractiveSettingValueStrings("ui-animations"),
		},
		{
			id: "animation-intensity",
			label: "Animation intensity",
			description: "Motion speed and update frequency",
			currentValue: currentSettingValue(settings, "animation-intensity"),
			values: getInteractiveSettingValueStrings("animation-intensity"),
		},
	];

	// Only show image toggle if terminal supports it
	if (supportsImages) {
		// Insert after autocompact
		items.splice(1, 0, {
			id: "show-images",
			label: "Show images",
			description: "Render images inline in terminal",
			currentValue: currentSettingValue(settings, "show-images"),
			values: getInteractiveSettingValueStrings("show-images"),
		});
		items.splice(2, 0, {
			id: "image-width-cells",
			label: "Image width",
			description: "Preferred inline image width in terminal cells",
			currentValue: currentSettingValue(settings, "image-width-cells"),
			values: getInteractiveSettingValueStrings("image-width-cells"),
		});
	}

	// Image auto-resize toggle (always available, affects both attached and read images)
	items.splice(supportsImages ? 3 : 1, 0, {
		id: "auto-resize-images",
		label: "Auto-resize images",
		description: "Resize large images to 2000x2000 max for better model compatibility",
		currentValue: currentSettingValue(settings, "auto-resize-images"),
		values: getInteractiveSettingValueStrings("auto-resize-images"),
	});

	// Block images toggle (always available, insert after auto-resize-images)
	const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
	items.splice(autoResizeIndex + 1, 0, {
		id: "block-images",
		label: "Block images",
		description: "Prevent images from being sent to LLM providers",
		currentValue: currentSettingValue(settings, "block-images"),
		values: getInteractiveSettingValueStrings("block-images"),
	});

	// Skill commands toggle (insert after block-images)
	const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
	items.splice(blockImagesIndex + 1, 0, {
		id: "skill-commands",
		label: "Skill commands",
		description: "Show skills in Command",
		currentValue: currentSettingValue(settings, "skill-commands"),
		values: getInteractiveSettingValueStrings("skill-commands"),
	});

	// Hardware cursor toggle (insert after skill-commands)
	const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
	items.splice(skillCommandsIndex + 1, 0, {
		id: "show-hardware-cursor",
		label: "Show hardware cursor",
		description: "Show the terminal cursor while still positioning it for IME support",
		currentValue: currentSettingValue(settings, "show-hardware-cursor"),
		values: getInteractiveSettingValueStrings("show-hardware-cursor"),
	});

	// Editor padding toggle (insert after show-hardware-cursor)
	const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
	items.splice(hardwareCursorIndex + 1, 0, {
		id: "editor-padding",
		label: "Editor padding",
		description: "Horizontal padding for input editor (0-3)",
		currentValue: currentSettingValue(settings, "editor-padding"),
		values: getInteractiveSettingValueStrings("editor-padding"),
	});

	// Output padding toggle (insert after editor-padding)
	const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
	items.splice(editorPaddingIndex + 1, 0, {
		id: "output-padding",
		label: "Output padding",
		description: "Horizontal padding for user messages, assistant messages, and thinking",
		currentValue: currentSettingValue(settings, "output-padding"),
		values: getInteractiveSettingValueStrings("output-padding"),
	});

	// Autocomplete max visible toggle (insert after output-padding)
	const outputPaddingIndex = items.findIndex((item) => item.id === "output-padding");
	items.splice(outputPaddingIndex + 1, 0, {
		id: "autocomplete-max-visible",
		label: "Autocomplete max items",
		description: "Max visible items in autocomplete dropdown (3-20)",
		currentValue: currentSettingValue(settings, "autocomplete-max-visible"),
		values: getInteractiveSettingValueStrings("autocomplete-max-visible"),
	});

	// Clear on shrink toggle (insert after autocomplete-max-visible)
	const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
	items.splice(autocompleteIndex + 1, 0, {
		id: "clear-on-shrink",
		label: "Clear on shrink",
		description: "Clear empty rows when content shrinks (may cause flicker)",
		currentValue: currentSettingValue(settings, "clear-on-shrink"),
		values: getInteractiveSettingValueStrings("clear-on-shrink"),
	});

	// Terminal progress toggle (insert after clear-on-shrink)
	const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
	items.splice(clearOnShrinkIndex + 1, 0, {
		id: "terminal-progress",
		label: "Terminal progress",
		description: "Show OSC 9;4 progress indicators in the terminal tab bar",
		currentValue: currentSettingValue(settings, "terminal-progress"),
		values: getInteractiveSettingValueStrings("terminal-progress"),
	});

	const onSettingChange: SettingsListOnChange = async (id, newValue) => {
		if (id === "theme") return callbacks.onThemeChange(newValue);
		if (isInteractiveSettingId(id)) {
			return callbacks.onInteractiveSettingChange(id, parseInteractiveSettingValue(id, newValue));
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
