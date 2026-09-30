import { describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { commitInteractiveSetting } from "../src/core/settings-operations.ts";
import {
	createSettingsDefinition,
	type SettingsCallbacks,
} from "../src/modes/interactive/components/settings-definition.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const settingsContext = {
	autoCompact: false,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	currentTheme: "dark",
	terminalTheme: "dark",
	availableThemes: ["dark", "light"],
} as const;

describe("settings definition", () => {
	it("keeps the theme submenu open and shows async save errors", async () => {
		initTheme("dark");
		const definition = createSettingsDefinition(SettingsManager.inMemory(), settingsContext, {
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

	it("saves warning toggles through the shared interactive setting operation", async () => {
		initTheme("dark");
		const settings = SettingsManager.inMemory();
		const onInteractiveSettingChange = vi.fn(async (id, value) => {
			await commitInteractiveSetting(settings, "global", id, value);
		});
		const definition = createSettingsDefinition(settings, settingsContext, {
			onInteractiveSettingChange,
			onThemeChange: vi.fn(),
			onThemePreview: vi.fn(),
			onCancel: vi.fn(),
		} satisfies SettingsCallbacks);
		const warningSetting = definition.items.find((item) => item.id === "warnings");
		if (!warningSetting?.submenu) throw new Error("Warnings submenu is missing");
		const submenu = warningSetting.submenu(warningSetting.currentValue, vi.fn());
		if (!submenu.handleInput) throw new Error("Warnings submenu does not accept input");

		submenu.handleInput("\r");
		await new Promise((resolve) => setImmediate(resolve));

		expect(onInteractiveSettingChange).toHaveBeenCalledWith("anthropic-extra-usage", false);
		expect(settings.getWarnings().anthropicExtraUsage).toBe(false);
	});
});
