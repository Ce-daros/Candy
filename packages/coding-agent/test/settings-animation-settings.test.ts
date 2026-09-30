import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("animation settings", () => {
	it("defaults to enabled animations with moderate intensity", () => {
		const settings = SettingsManager.inMemory();

		expect(settings.read("ui-animations")).toBe(true);
		expect(settings.read("animation-intensity")).toBe("moderate");
	});

	it("persists animation choices", async () => {
		const settings = SettingsManager.inMemory();

		await settings.commitSetting("global", "uiAnimations", false);
		await settings.commitSetting("global", "animationIntensity", "aggressive");
		await settings.flush();

		expect(settings.read("ui-animations")).toBe(false);
		expect(settings.read("animation-intensity")).toBe("aggressive");

		await settings.reload();
		expect(settings.read("ui-animations")).toBe(false);
		expect(settings.read("animation-intensity")).toBe("aggressive");
	});
});
