import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { INTERACTIVE_SETTING_VALUES, type InteractiveSettingId } from "./interactive-setting-values.ts";
import type { Settings, SettingsManager, SettingsScope } from "./settings-manager.ts";
import type { SettingValueSource } from "./settings-types.ts";

export function isInteractiveSettingId(value: string): value is InteractiveSettingId {
	return Object.hasOwn(INTERACTIVE_SETTING_VALUES, value);
}

export async function commitInteractiveSetting(
	settings: SettingsManager,
	scope: SettingsScope,
	id: InteractiveSettingId,
	value: unknown,
	options: { clear?: boolean } = {},
): Promise<void> {
	const clear = options.clear ?? false;
	if (scope !== "global" && scope !== "project") throw new Error(`Invalid settings scope: ${String(scope)}`);
	if (scope === "project" && (id === "default-project-trust" || id === "cache-warming-mode")) {
		throw new Error(`Setting ${id} can only be saved globally`);
	}
	if (!clear && !INTERACTIVE_SETTING_VALUES[id].some((candidate) => Object.is(candidate, value))) {
		throw new Error(`Invalid value for setting ${id}`);
	}
	const committed = clear ? undefined : value;

	switch (id) {
		case "anthropic-extra-usage":
			return settings.commitNestedSetting(
				scope,
				"warnings",
				"anthropicExtraUsage",
				committed as boolean | undefined,
			);
		case "autocompact":
			return settings.commitNestedSetting(scope, "compaction", "enabled", committed as boolean | undefined);
		case "steering-mode":
			return settings.commitSetting(scope, "steeringMode", committed as "all" | "one-at-a-time" | undefined);
		case "follow-up-mode":
			return settings.commitSetting(scope, "followUpMode", committed as "all" | "one-at-a-time" | undefined);
		case "default-thinking-level":
			return settings.commitSetting(
				scope,
				"defaultThinkingLevel",
				committed as SettingsManagerSetting<"defaultThinkingLevel">,
			);
		case "transport":
			return settings.commitSetting(scope, "transport", committed as SettingsManagerSetting<"transport">);
		case "http-idle-timeout":
			return settings.commitSetting(scope, "httpIdleTimeoutMs", committed as number | undefined);
		case "cache-warming-mode":
			return settings.commitSetting(scope, "cacheWarming", committed as SettingsManagerSetting<"cacheWarming">);
		case "hide-thinking":
			return settings.commitSetting(scope, "hideThinkingBlock", committed as boolean | undefined);
		case "tool-preview-lines":
			return settings.commitSetting(
				scope,
				"toolPreviewLines",
				committed as SettingsManagerSetting<"toolPreviewLines">,
			);
		case "mermaid-rendering":
			return settings.commitNestedSetting(scope, "markdown", "mermaid", committed as string | undefined);
		case "cache-miss-notices":
			return settings.commitSetting(scope, "showCacheMissNotices", committed as boolean | undefined);
		case "collapse-changelog":
			return settings.commitSetting(scope, "collapseChangelog", committed as boolean | undefined);
		case "quiet-startup":
			return settings.commitSetting(scope, "quietStartup", committed as boolean | undefined);
		case "install-telemetry":
			return settings.commitSetting(scope, "enableInstallTelemetry", committed as boolean | undefined);
		case "default-project-trust":
			return settings.commitSetting(
				scope,
				"defaultProjectTrust",
				committed as SettingsManagerSetting<"defaultProjectTrust">,
			);
		case "double-escape-action":
			return settings.commitSetting(
				scope,
				"doubleEscapeAction",
				committed as SettingsManagerSetting<"doubleEscapeAction">,
			);
		case "tree-filter-mode":
			return settings.commitSetting(scope, "treeFilterMode", committed as SettingsManagerSetting<"treeFilterMode">);
		case "show-hardware-cursor":
			return settings.commitSetting(scope, "showHardwareCursor", committed as boolean | undefined);
		case "show-images":
			return settings.commitNestedSetting(scope, "terminal", "showImages", committed as boolean | undefined);
		case "image-width-cells":
			return settings.commitNestedSetting(scope, "terminal", "imageWidthCells", committed as number | undefined);
		case "auto-resize-images":
			return settings.commitNestedSetting(scope, "images", "autoResize", committed as boolean | undefined);
		case "block-images":
			return settings.commitNestedSetting(scope, "images", "blockImages", committed as boolean | undefined);
		case "skill-commands":
			return settings.commitSetting(scope, "enableSkillCommands", committed as boolean | undefined);
		case "editor-padding":
			return settings.commitSetting(scope, "editorPaddingX", committed as number | undefined);
		case "output-padding":
			return settings.commitSetting(scope, "outputPad", committed as SettingsManagerSetting<"outputPad">);
		case "autocomplete-max-visible":
			return settings.commitSetting(scope, "autocompleteMaxVisible", committed as number | undefined);
		case "clear-on-shrink":
			return settings.commitNestedSetting(scope, "terminal", "clearOnShrink", committed as boolean | undefined);
		case "terminal-progress":
			return settings.commitNestedSetting(
				scope,
				"terminal",
				"showTerminalProgress",
				committed as boolean | undefined,
			);
		case "fullscreen-exit-output":
			return settings.commitSetting(
				scope,
				"fullscreenExitOutput",
				committed as SettingsManagerSetting<"fullscreenExitOutput">,
			);
		case "fullscreen-scrollbar":
			return settings.commitSetting(
				scope,
				"fullscreenScrollbar",
				committed as SettingsManagerSetting<"fullscreenScrollbar">,
			);
		case "fullscreen-copy-on-select":
			return settings.commitSetting(scope, "fullscreenCopyOnSelect", committed as boolean | undefined);
		case "ui-animations":
			return settings.commitSetting(scope, "uiAnimations", committed as boolean | undefined);
		case "animation-intensity":
			return settings.commitSetting(
				scope,
				"animationIntensity",
				committed as SettingsManagerSetting<"animationIntensity">,
			);
	}
}

export function getInteractiveSettingState<Id extends InteractiveSettingId>(
	settings: SettingsManager,
	id: Id,
): {
	value: (typeof INTERACTIVE_SETTING_VALUES)[Id][number];
	source: SettingValueSource;
	writableScopes: readonly SettingsScope[];
} {
	const state = (value: unknown, field: keyof Settings, nestedPath?: string) => ({
		value: value as (typeof INTERACTIVE_SETTING_VALUES)[Id][number],
		source: settings.getSettingSource(field, nestedPath),
		writableScopes:
			id === "default-project-trust" || id === "cache-warming-mode"
				? (["global"] as const)
				: (["global", "project"] as const),
	});
	switch (id) {
		case "anthropic-extra-usage":
			return state(settings.getWarnings().anthropicExtraUsage ?? true, "warnings", "anthropicExtraUsage");
		case "autocompact":
			return state(settings.getCompactionEnabled(), "compaction", "enabled");
		case "steering-mode":
			return state(settings.getSteeringMode(), "steeringMode");
		case "follow-up-mode":
			return state(settings.getFollowUpMode(), "followUpMode");
		case "default-thinking-level":
			return state(settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL, "defaultThinkingLevel");
		case "transport":
			return state(settings.getTransport(), "transport");
		case "http-idle-timeout":
			return state(settings.getHttpIdleTimeoutMs(), "httpIdleTimeoutMs");
		case "cache-warming-mode":
			return state(settings.getCacheWarmingMode(), "cacheWarming");
		case "hide-thinking":
			return state(settings.getHideThinkingBlock(), "hideThinkingBlock");
		case "tool-preview-lines":
			return state(settings.getToolPreviewLines(), "toolPreviewLines");
		case "mermaid-rendering":
			return state(settings.getMermaidRenderingMode(), "markdown", "mermaid");
		case "cache-miss-notices":
			return state(settings.getShowCacheMissNotices(), "showCacheMissNotices");
		case "collapse-changelog":
			return state(settings.getCollapseChangelog(), "collapseChangelog");
		case "quiet-startup":
			return state(settings.getQuietStartup(), "quietStartup");
		case "install-telemetry":
			return state(settings.getEnableInstallTelemetry(), "enableInstallTelemetry");
		case "default-project-trust":
			return state(settings.getDefaultProjectTrust(), "defaultProjectTrust");
		case "double-escape-action":
			return state(settings.getDoubleEscapeAction(), "doubleEscapeAction");
		case "tree-filter-mode":
			return state(settings.getTreeFilterMode(), "treeFilterMode");
		case "show-hardware-cursor":
			return state(settings.getShowHardwareCursor(), "showHardwareCursor");
		case "show-images":
			return state(settings.getShowImages(), "terminal", "showImages");
		case "image-width-cells":
			return state(settings.getImageWidthCells(), "terminal", "imageWidthCells");
		case "auto-resize-images":
			return state(settings.getImageAutoResize(), "images", "autoResize");
		case "block-images":
			return state(settings.getBlockImages(), "images", "blockImages");
		case "skill-commands":
			return state(settings.getEnableSkillCommands(), "enableSkillCommands");
		case "editor-padding":
			return state(settings.getEditorPaddingX(), "editorPaddingX");
		case "output-padding":
			return state(settings.getOutputPad(), "outputPad");
		case "autocomplete-max-visible":
			return state(settings.getAutocompleteMaxVisible(), "autocompleteMaxVisible");
		case "clear-on-shrink":
			return state(settings.getClearOnShrink(), "terminal", "clearOnShrink");
		case "terminal-progress":
			return state(settings.getShowTerminalProgress(), "terminal", "showTerminalProgress");
		case "fullscreen-exit-output":
			return state(settings.getFullscreenExitOutput(), "fullscreenExitOutput");
		case "fullscreen-scrollbar":
			return state(settings.getFullscreenScrollbar(), "fullscreenScrollbar");
		case "fullscreen-copy-on-select":
			return state(settings.getFullscreenCopyOnSelect(), "fullscreenCopyOnSelect");
		case "ui-animations":
			return state(settings.getUiAnimations(), "uiAnimations");
		case "animation-intensity":
			return state(settings.getAnimationIntensity(), "animationIntensity");
	}
}

type SettingsManagerSetting<K extends keyof Settings> = Settings[K] | undefined;
