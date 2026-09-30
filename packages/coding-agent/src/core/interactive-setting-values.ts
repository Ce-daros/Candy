import type { ThinkingLevel } from "@candy/agent-core";
import type { Transport } from "@candy/ai";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, HTTP_IDLE_TIMEOUT_CHOICES, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";
import type {
	AnimationIntensity,
	CacheWarmingMode,
	DefaultProjectTrust,
	FullscreenExitOutput,
	MermaidRenderingMode,
	Settings,
	SettingsScope,
} from "./settings-types.ts";
import { ANIMATION_INTENSITIES, CACHE_WARMING_MODES } from "./settings-types.ts";

type SettingLocation = { field: keyof Settings; nestedPath?: string };
type WritableScopes = readonly SettingsScope[];
interface SettingsReadHost {
	getSetting<K extends keyof Settings>(field: K): Settings[K] | undefined;
	getGlobalSettings(): Settings;
}

interface SettingDefinition<Values extends readonly unknown[], ReadValue = Values[number]> {
	values: Values;
	defaultValue: ReadValue;
	writableScopes: WritableScopes;
	location: SettingLocation;
	read: (settings: SettingsReadHost) => ReadValue;
}

const BOTH_SCOPES = ["global", "project"] as const;
const GLOBAL_ONLY = ["global"] as const;

function readLocatedValue(settings: SettingsReadHost, location: SettingLocation): unknown {
	const value = settings.getSetting(location.field);
	if (location.nestedPath === undefined) return value;
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Invalid ${String(location.field)} setting: expected an object`);
	}
	return (value as Record<string, unknown>)[location.nestedPath];
}

function defineSetting<const Values extends readonly unknown[], ReadValue = Values[number]>(
	values: Values,
	defaultValue: NoInfer<ReadValue>,
	location: SettingLocation,
	writableScopes: WritableScopes = BOTH_SCOPES,
	readSpecial?: (settings: SettingsReadHost, configured: unknown) => ReadValue | undefined,
): SettingDefinition<Values, ReadValue> {
	return {
		values,
		defaultValue,
		writableScopes,
		location,
		read: (settings) => {
			const configured = readLocatedValue(settings, location);
			if (readSpecial) return (readSpecial(settings, configured) ?? defaultValue) as ReadValue;
			const value = configured;
			if (value === undefined) return defaultValue;
			if (!values.some((candidate) => Object.is(candidate, value))) {
				throw new Error(`Invalid ${String(location.field)} setting: ${String(value)}`);
			}
			return value as ReadValue;
		},
	};
}

function direct<const Values extends readonly unknown[], ReadValue = Values[number]>(
	values: Values,
	defaultValue: NoInfer<ReadValue>,
	field: keyof Settings,
	scopes: WritableScopes = BOTH_SCOPES,
	readSpecial?: (settings: SettingsReadHost, configured: unknown) => ReadValue | undefined,
): SettingDefinition<Values, ReadValue> {
	return defineSetting(values, defaultValue, { field }, scopes, readSpecial);
}

function nested<const Values extends readonly unknown[], ReadValue = Values[number]>(
	values: Values,
	defaultValue: NoInfer<ReadValue>,
	field: keyof Settings,
	nestedPath: string,
	readSpecial?: (settings: SettingsReadHost, configured: unknown) => ReadValue | undefined,
): SettingDefinition<Values, ReadValue> {
	return defineSetting(values, defaultValue, { field, nestedPath }, BOTH_SCOPES, readSpecial);
}

function readCacheWarmingMode(settings: SettingsReadHost, _configured: unknown): CacheWarmingMode | undefined {
	const globalValue = settings.getGlobalSettings().cacheWarming;
	return globalValue !== undefined && CACHE_WARMING_MODES.includes(globalValue) ? globalValue : undefined;
}

function readTimeout(_settings: SettingsReadHost, configured: unknown): number | undefined {
	if (configured === undefined) return undefined;
	const timeout = parseHttpIdleTimeoutMs(configured);
	if (timeout === undefined) throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(configured)}`);
	return timeout;
}

function readMermaidMode(_settings: SettingsReadHost, configured: unknown): MermaidRenderingMode | undefined {
	return configured === "off" || configured === "final" || configured === "streaming" ? configured : undefined;
}

function readDefaultProjectTrust(settings: SettingsReadHost): DefaultProjectTrust | undefined {
	const value = settings.getGlobalSettings().defaultProjectTrust;
	return value === "ask" || value === "always" || value === "never" ? value : undefined;
}

function readTreeFilterMode(_settings: SettingsReadHost, configured: unknown) {
	return configured === "default" ||
		configured === "no-tools" ||
		configured === "user-only" ||
		configured === "labeled-only" ||
		configured === "all"
		? configured
		: undefined;
}

function readImageWidth(_settings: SettingsReadHost, configured: unknown): number | undefined {
	if (typeof configured !== "number" || !Number.isFinite(configured)) return undefined;
	return Math.max(1, Math.floor(configured));
}

function readClearOnShrink(_settings: SettingsReadHost, configured: unknown): boolean | undefined {
	if (configured === undefined) return process.env.CANDY_CLEAR_ON_SHRINK === "1";
	if (typeof configured !== "boolean")
		throw new Error(`Invalid terminal.clearOnShrink setting: ${String(configured)}`);
	return configured;
}

function readHardwareCursor(_settings: SettingsReadHost, configured: unknown): boolean | undefined {
	if (configured === undefined) return process.env.CANDY_HARDWARE_CURSOR === "1";
	if (typeof configured !== "boolean") throw new Error(`Invalid showHardwareCursor setting: ${String(configured)}`);
	return configured;
}

function readFullscreenExitOutput(_settings: SettingsReadHost, configured: unknown): FullscreenExitOutput | undefined {
	return configured === "resume-hint" || configured === "transcript" ? configured : undefined;
}

function readFullscreenScrollbar(_settings: SettingsReadHost, configured: unknown) {
	return configured === "always" || configured === "hidden" || configured === "auto" ? configured : undefined;
}

function readOutputPadding(_settings: SettingsReadHost, configured: unknown): 0 | 1 | undefined {
	return configured === 0 || configured === 1 ? configured : undefined;
}

export const INTERACTIVE_SETTINGS = {
	"anthropic-extra-usage": nested([true, false], true, "warnings", "anthropicExtraUsage"),
	autocompact: nested([true, false], true, "compaction", "enabled"),
	"steering-mode": direct(["one-at-a-time", "all"], "one-at-a-time", "steeringMode"),
	"follow-up-mode": direct(["one-at-a-time", "all"], "one-at-a-time", "followUpMode"),
	"default-thinking-level": defineSetting(
		["off", "minimal", "low", "medium", "high", "xhigh", "max"] satisfies readonly ThinkingLevel[],
		DEFAULT_THINKING_LEVEL,
		{ field: "defaultThinkingLevel" },
	),
	transport: direct(
		["sse", "websocket", "websocket-cached", "auto"] satisfies readonly Transport[],
		"auto",
		"transport",
	),
	"http-idle-timeout": direct(
		HTTP_IDLE_TIMEOUT_CHOICES.map(
			(choice) => choice.timeoutMs,
		) as (typeof HTTP_IDLE_TIMEOUT_CHOICES)[number]["timeoutMs"][],
		DEFAULT_HTTP_IDLE_TIMEOUT_MS,
		"httpIdleTimeoutMs",
		BOTH_SCOPES,
		readTimeout,
	),
	"cache-warming-mode": direct(
		CACHE_WARMING_MODES satisfies readonly CacheWarmingMode[],
		"streaming",
		"cacheWarming",
		GLOBAL_ONLY,
		readCacheWarmingMode,
	),
	"hide-thinking": direct([true, false], true, "hideThinkingBlock"),
	"tool-preview-lines": direct([5, 10, 20], 5, "toolPreviewLines"),
	"mermaid-rendering": nested(
		["off", "final", "streaming"] satisfies readonly MermaidRenderingMode[],
		"final",
		"markdown",
		"mermaid",
		readMermaidMode,
	),
	"cache-miss-notices": direct([true, false], false, "showCacheMissNotices"),
	"collapse-changelog": direct([true, false], true, "collapseChangelog"),
	"quiet-startup": direct([false, true], false, "quietStartup"),
	"install-telemetry": direct([false, true], true, "enableInstallTelemetry"),
	"default-project-trust": direct(
		["ask", "always", "never"] satisfies readonly DefaultProjectTrust[],
		"ask",
		"defaultProjectTrust",
		GLOBAL_ONLY,
		readDefaultProjectTrust,
	),
	"double-escape-action": direct(["tree", "fork", "none"], "tree", "doubleEscapeAction"),
	"tree-filter-mode": direct(
		["default", "no-tools", "user-only", "labeled-only", "all"],
		"default",
		"treeFilterMode",
		BOTH_SCOPES,
		readTreeFilterMode,
	),
	"show-hardware-cursor": direct([false, true], false, "showHardwareCursor", BOTH_SCOPES, readHardwareCursor),
	"show-images": nested([true, false], true, "terminal", "showImages"),
	"image-width-cells": nested([60, 80, 120], 60, "terminal", "imageWidthCells", readImageWidth),
	"auto-resize-images": nested([true, false], true, "images", "autoResize"),
	"block-images": nested([true, false], false, "images", "blockImages"),
	"skill-commands": direct([true, false], true, "enableSkillCommands"),
	"editor-padding": direct([0, 1, 2, 3], 0, "editorPaddingX"),
	"output-padding": direct([0, 1], 1, "outputPad", BOTH_SCOPES, readOutputPadding),
	"autocomplete-max-visible": direct([3, 5, 7, 10, 15, 20], 5, "autocompleteMaxVisible"),
	"clear-on-shrink": nested([false, true], false, "terminal", "clearOnShrink", readClearOnShrink),
	"terminal-progress": nested([false, true], false, "terminal", "showTerminalProgress"),
	"fullscreen-exit-output": direct(
		["transcript", "resume-hint"] satisfies readonly FullscreenExitOutput[],
		"transcript",
		"fullscreenExitOutput",
		BOTH_SCOPES,
		readFullscreenExitOutput,
	),
	"fullscreen-scrollbar": direct(
		["auto", "always", "hidden"] as const,
		"auto",
		"fullscreenScrollbar",
		BOTH_SCOPES,
		readFullscreenScrollbar,
	),
	"fullscreen-copy-on-select": direct([true, false], true, "fullscreenCopyOnSelect"),
	"ui-animations": direct([true, false], true, "uiAnimations"),
	"animation-intensity": direct(
		ANIMATION_INTENSITIES satisfies readonly AnimationIntensity[],
		"moderate",
		"animationIntensity",
	),
} as const;

export type InteractiveSettingId = keyof typeof INTERACTIVE_SETTINGS;
export type InteractiveSettingValue<Id extends InteractiveSettingId> =
	(typeof INTERACTIVE_SETTINGS)[Id]["values"][number];
export type InteractiveSettingReadValue<Id extends InteractiveSettingId> = ReturnType<
	(typeof INTERACTIVE_SETTINGS)[Id]["read"]
>;

export function getInteractiveSettingValueStrings(id: InteractiveSettingId): string[] {
	return INTERACTIVE_SETTINGS[id].values.map(String);
}

export function parseInteractiveSettingValue<Id extends InteractiveSettingId>(
	id: Id,
	serialized: string,
): InteractiveSettingValue<Id> {
	const value = INTERACTIVE_SETTINGS[id].values.find((candidate) => String(candidate) === serialized);
	if (value === undefined) throw new Error(`Invalid value for setting ${id}: ${serialized}`);
	return value as InteractiveSettingValue<Id>;
}
