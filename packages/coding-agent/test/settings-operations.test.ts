import { describe, expect, it, vi } from "vitest";
import { INTERACTIVE_SETTINGS } from "../src/core/interactive-setting-values.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	commitInteractiveSetting,
	getInteractiveSettingState,
	isInteractiveSettingId,
} from "../src/core/settings-operations.ts";

describe("interactive settings catalog", () => {
	it("keeps each documented default among the setting's allowed values", () => {
		for (const definition of Object.values(INTERACTIVE_SETTINGS)) {
			expect(definition.values).toContain(definition.defaultValue);
		}
	});

	it("validates identifiers, values, and writable scopes before committing", async () => {
		const settings = SettingsManager.inMemory();
		const commit = vi.spyOn(settings, "commitSetting");

		expect(isInteractiveSettingId("transport")).toBe(true);
		expect(isInteractiveSettingId("not-a-setting")).toBe(false);
		await expect(commitInteractiveSetting(settings, "global", "transport", "invalid")).rejects.toThrow(
			"Invalid value for setting transport",
		);
		await expect(commitInteractiveSetting(settings, "project", "cache-warming-mode", "idle")).rejects.toThrow(
			"Setting cache-warming-mode can only be saved global",
		);
		expect(commit).not.toHaveBeenCalled();
	});

	it("reads the effective setting and its source from one catalog definition", async () => {
		const settings = SettingsManager.inMemory();
		settings.setProjectTrusted(true);
		await commitInteractiveSetting(settings, "project", "transport", "websocket");

		expect(getInteractiveSettingState(settings, "transport")).toEqual({
			value: "websocket",
			source: "project",
			writableScopes: ["global", "project"],
		});
		await commitInteractiveSetting(settings, "project", "transport", undefined, { clear: true });
		expect(getInteractiveSettingState(settings, "transport").source).toBe("default");
	});

	it("preserves explicit defaults when the setting is unset", () => {
		const settings = SettingsManager.inMemory();

		expect(getInteractiveSettingState(settings, "default-thinking-level").value).toBe("medium");
		expect(getInteractiveSettingState(settings, "anthropic-extra-usage").value).toBe(true);
	});

	it("rejects malformed configured values instead of hiding them with defaults", () => {
		const invalidTransport = SettingsManager.inMemory({ transport: "quic" as never });
		const invalidTerminal = SettingsManager.inMemory({ terminal: "enabled" as never });

		expect(() => invalidTransport.read("transport")).toThrow("Invalid transport setting: quic");
		expect(() => invalidTerminal.read("show-images")).toThrow("Invalid terminal setting: expected an object");
	});

	it("keeps valid configured values outside the interactive choices", () => {
		const settings = SettingsManager.inMemory({ terminal: { imageWidthCells: 100 }, httpIdleTimeoutMs: 45000 });

		expect(settings.read("image-width-cells")).toBe(100);
		expect(settings.read("http-idle-timeout")).toBe(45000);
	});
});
