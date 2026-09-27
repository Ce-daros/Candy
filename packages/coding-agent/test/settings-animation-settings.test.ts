import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("animation settings", () => {
	it("defaults to enabled animations with moderate intensity", () => {
		const settings = SettingsManager.inMemory();

		expect(settings.getUiAnimations()).toBe(true);
		expect(settings.getAnimationIntensity()).toBe("moderate");
	});

	it("persists animation choices", async () => {
		const settings = SettingsManager.inMemory();

		settings.setUiAnimations(false);
		settings.setAnimationIntensity("aggressive");
		await settings.flush();

		expect(settings.getUiAnimations()).toBe(false);
		expect(settings.getAnimationIntensity()).toBe("aggressive");

		await settings.reload();
		expect(settings.getUiAnimations()).toBe(false);
		expect(settings.getAnimationIntensity()).toBe("aggressive");
	});
});
