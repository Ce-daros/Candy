import { setKeybindings } from "@candy/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const onCopyOnSelectChange = vi.fn();
		const config = {
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			fullscreenCopyOnSelect: true,
			warnings: {},
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
			onFullscreenCopyOnSelectChange: onCopyOnSelectChange,
		} as unknown as SettingsCallbacks;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
		cycle("Fullscreen copy on select", 2);
		expect(onCopyOnSelectChange.mock.calls.flat()).toEqual([false, true]);
	});

	it("keeps the configured fixed theme marked while browsing", () => {
		const config = {
			currentTheme: "dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("    Automatic");
		expect(output).toContain("♦ ✓ dark");
		expect(output).toContain("● ● ● ● ● ●");
		expect(output).toContain("◆ Can you check this change?");
		expect(output).toContain("+ const newValue = true;");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ dark");
		expect(output).toContain("♦   light");
	});

	it("keeps a configured automatic theme marked while browsing", () => {
		const config = {
			currentTheme: "light/dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("♦ ✓ light");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ light");
		expect(output).toContain("♦   dark");
	});

	it("shares the global thinking setting with a dedicated control", () => {
		const onDefaultThinkingLevelChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			{ thinkingLevel: "medium", warnings: {} } as unknown as SettingsConfig,
			{ onDefaultThinkingLevelChange, onCancel: () => {} } as unknown as SettingsCallbacks,
		);
		expect(selector.getSettingItems().find((item) => item.id === "default-thinking-level")?.currentValue).toBe(
			"medium",
		);
		expect(selector.getSettingItems().some((item) => item.id === "model-thinking")).toBe(false);
		const control = selector.createSettingControl("default-thinking-level", () => {});
		control.handleInput?.("\r");
		expect(onDefaultThinkingLevelChange).toHaveBeenCalledWith("high");
	});

	it("navigates five categories and searches settings from the bottom input", () => {
		const config: SettingsConfig = {
			autoCompact: true,
			showImages: false,
			imageWidthCells: 80,
			autoResizeImages: true,
			blockImages: false,
			enableSkillCommands: true,
			steeringMode: "all",
			followUpMode: "all",
			transport: "auto",
			httpIdleTimeoutMs: 300_000,
			cacheWarmingMode: "off",
			thinkingLevel: "medium",
			availableThemes: ["dark", "light"],
			currentTheme: "dark",
			uiAnimations: true,
			animationIntensity: "moderate",
			terminalTheme: "dark",
			hideThinkingBlock: true,
			mermaidRenderingMode: "final",
			showCacheMissNotices: true,
			collapseChangelog: true,
			enableInstallTelemetry: false,
			doubleEscapeAction: "tree",
			treeFilterMode: "default",
			warnings: {},
			toolPreviewLines: 5,
			showHardwareCursor: true,
			editorPaddingX: 1,
			outputPad: 0,
			autocompleteMaxVisible: 7,
			quietStartup: false,
			defaultProjectTrust: "ask",
			clearOnShrink: false,
			showTerminalProgress: true,
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			fullscreenCopyOnSelect: true,
		};
		const onCancel = vi.fn();
		const selector = new SettingsSelectorComponent(config, { onCancel } as unknown as SettingsCallbacks);
		selector.setAvailableHeight(18);
		let output = stripAnsi(selector.render(120).join("\n"));
		for (const category of [
			"Appearance",
			"Conversation & Input",
			"Models & Connection",
			"Privacy & Trust",
			"Terminal",
		]) {
			expect(output).toContain(category);
		}
		selector.handleInput("\t");
		selector.handleInput("\x1b[B");
		output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("♦ Conversation & Input ♦");
		selector.setAvailableHeight(17);
		for (let index = 0; index < 3; index++) selector.handleInput("\x1b[B");
		const narrow = stripAnsi(selector.render(76).join("\n")).split("\n");
		expect(narrow).toHaveLength(17);
		expect(narrow[2]).toContain("Terminal");
		expect(narrow.at(-2)).toContain("Search");
		selector.handleInput("t");
		selector.handleInput("o");
		selector.handleInput("o");
		selector.handleInput("l");
		output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Tool preview lines");
		selector.handleInput("\x1b");
		expect(onCancel).not.toHaveBeenCalled();

		const searched = new SettingsSelectorComponent(config, { onCancel } as unknown as SettingsCallbacks);
		for (const character of "e") searched.handleInput(character);
		const selectedLine = () =>
			stripAnsi(searched.render(120).join("\n"))
				.split("\n")
				.find((line) => line.includes("‹ ") && line.includes(" ›"));
		const first = selectedLine();
		searched.handleInput("\x1b[B");
		expect(selectedLine()).not.toBe(first);
		searched.handleInput("\x1b[A");
		expect(selectedLine()).toBe(first);
	});
});
