import { describe, expect, it, vi } from "vitest";
import {
	createSettingsDefinition,
	type SettingsCallbacks,
	type SettingsConfig,
} from "../src/modes/interactive/components/settings-definition.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const config = {
	autoCompact: false,
	showImages: true,
	imageWidthCells: 80,
	autoResizeImages: true,
	blockImages: false,
	enableSkillCommands: true,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	transport: "auto",
	httpIdleTimeoutMs: 300_000,
	cacheWarmingMode: "off",
	thinkingLevel: "medium",
	currentTheme: "dark",
	uiAnimations: true,
	animationIntensity: "moderate",
	terminalTheme: "dark",
	availableThemes: ["dark", "light"],
	hideThinkingBlock: false,
	mermaidRenderingMode: "off",
	showCacheMissNotices: false,
	collapseChangelog: false,
	enableInstallTelemetry: false,
	doubleEscapeAction: "tree",
	treeFilterMode: "default",
	toolPreviewLines: 10,
	showHardwareCursor: false,
	editorPaddingX: 0,
	outputPad: 0,
	autocompleteMaxVisible: 5,
	quietStartup: false,
	defaultProjectTrust: "ask",
	clearOnShrink: false,
	showTerminalProgress: false,
	fullscreenExitOutput: "transcript",
	fullscreenScrollbar: "auto",
	fullscreenCopyOnSelect: true,
	warnings: {},
} satisfies SettingsConfig;

describe("settings definition", () => {
	it("keeps the theme submenu open and shows async save errors", async () => {
		initTheme("dark");
		const definition = createSettingsDefinition(config, {
			onThemeChange: async () => {
				throw new Error("Could not save settings");
			},
			onThemePreview: vi.fn(),
		} as unknown as SettingsCallbacks);
		const themeSetting = definition.items.find((item) => item.id === "theme");
		if (!themeSetting?.submenu) throw new Error("Theme setting submenu is missing");
		const done = vi.fn(async (value?: string) => {
			if (value !== undefined) await definition.onChange("theme", value);
		});
		const submenu = themeSetting.submenu(themeSetting.currentValue, done);
		if (!submenu.handleInput) throw new Error("Theme submenu does not accept input");

		submenu.handleInput("\r");
		await new Promise((resolve) => setImmediate(resolve));

		expect(done).toHaveBeenCalledOnce();
		expect(stripAnsi(submenu.render(80).join("\n"))).toContain("Could not save theme: Could not save settings");
	});
});
