import type { ThinkingLevel } from "@candy/agent-core";
import type { Transport } from "@candy/ai";
import { HTTP_IDLE_TIMEOUT_CHOICES } from "./http-dispatcher.ts";
import type {
	AnimationIntensity,
	CacheWarmingMode,
	DefaultProjectTrust,
	FullscreenExitOutput,
	MermaidRenderingMode,
} from "./settings-types.ts";
import { CACHE_WARMING_MODES } from "./settings-types.ts";

type FullscreenScrollbar = "auto" | "always" | "hidden";

export const INTERACTIVE_SETTING_VALUES = {
	"anthropic-extra-usage": [true, false],
	autocompact: [true, false],
	"steering-mode": ["one-at-a-time", "all"],
	"follow-up-mode": ["one-at-a-time", "all"],
	"default-thinking-level": [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	] satisfies readonly ThinkingLevel[],
	transport: ["sse", "websocket", "websocket-cached", "auto"] satisfies readonly Transport[],
	"http-idle-timeout": HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.timeoutMs),
	"cache-warming-mode": CACHE_WARMING_MODES satisfies readonly CacheWarmingMode[],
	"hide-thinking": [true, false],
	"tool-preview-lines": [5, 10, 20],
	"mermaid-rendering": ["off", "final", "streaming"] satisfies readonly MermaidRenderingMode[],
	"cache-miss-notices": [true, false],
	"collapse-changelog": [true, false],
	"quiet-startup": [false, true],
	"install-telemetry": [false, true],
	"default-project-trust": ["ask", "always", "never"] satisfies readonly DefaultProjectTrust[],
	"double-escape-action": ["tree", "fork", "none"],
	"tree-filter-mode": ["default", "no-tools", "user-only", "labeled-only", "all"],
	"show-hardware-cursor": [false, true],
	"show-images": [true, false],
	"image-width-cells": [60, 80, 120],
	"auto-resize-images": [true, false],
	"block-images": [true, false],
	"skill-commands": [true, false],
	"editor-padding": [0, 1, 2, 3],
	"output-padding": [0, 1],
	"autocomplete-max-visible": [3, 5, 7, 10, 15, 20],
	"clear-on-shrink": [false, true],
	"terminal-progress": [false, true],
	"fullscreen-exit-output": ["transcript", "resume-hint"] satisfies readonly FullscreenExitOutput[],
	"fullscreen-copy-on-select": [true, false],
	"ui-animations": [true, false],
	"animation-intensity": ["conservative", "moderate", "aggressive"] satisfies readonly AnimationIntensity[],
	"fullscreen-scrollbar": ["auto", "always", "hidden"] satisfies readonly FullscreenScrollbar[],
} as const;

export type InteractiveSettingId = keyof typeof INTERACTIVE_SETTING_VALUES;
export type InteractiveSettingValue<Id extends InteractiveSettingId> = (typeof INTERACTIVE_SETTING_VALUES)[Id][number];

export function getInteractiveSettingValueStrings(id: InteractiveSettingId): string[] {
	return INTERACTIVE_SETTING_VALUES[id].map(String);
}

export function parseInteractiveSettingValue<Id extends InteractiveSettingId>(
	id: Id,
	serialized: string,
): InteractiveSettingValue<Id> {
	const value = INTERACTIVE_SETTING_VALUES[id].find((candidate) => String(candidate) === serialized);
	if (value === undefined) throw new Error(`Invalid value for setting ${id}: ${serialized}`);
	return value as InteractiveSettingValue<Id>;
}
