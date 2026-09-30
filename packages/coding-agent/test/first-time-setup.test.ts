import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldRunFirstTimeSetup } from "../src/cli/startup-ui.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { FirstTimeSetupComponent } from "../src/modes/interactive/components/first-time-setup.ts";
import { SplashLogoComponent } from "../src/modes/interactive/components/splash.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("first-time setup viewport", () => {
	it("scales both logo dimensions, including a one-row height", () => {
		const full = new SplashLogoComponent().render(80);
		const compact = new SplashLogoComponent(8).render(80);
		const tiny = new SplashLogoComponent(1).render(80);
		expect(full).toHaveLength(14);
		expect(compact).toHaveLength(8);
		expect(tiny).toHaveLength(1);
		expect(stripAnsi(compact[0]).length).toBeLessThan(stripAnsi(full[0]).length);
	});

	it("keeps theme choices visible at 80 by 24 and grows the logo after a resize", () => {
		initTheme("dark");
		let height = 24;
		let submitted: { theme: string } | undefined;
		const setup = new FirstTimeSetupComponent({
			detectedTheme: "dark",
			getAvailableHeight: () => height,
			onThemePreview: () => {},
			onSubmit: (result) => {
				submitted = result;
			},
			onCancel: () => {},
		});
		const compact = setup.render(80);
		expect(compact.length).toBeLessThanOrEqual(height);
		expect(stripAnsi(compact.join("\n"))).toContain("Light");
		setup.handleInput("\n");
		expect(submitted).toEqual({ theme: "dark" });
		height = 45;
		expect(setup.render(160).length).toBeGreaterThan(compact.length);
	});
});

describe("shouldRunFirstTimeSetup", () => {
	const originalAgentDir = process.env[ENV_AGENT_DIR];
	let tempDir: string;
	let settingsPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-first-time-setup-"));
		settingsPath = join(tempDir, "settings.json");
		delete process.env[ENV_AGENT_DIR];
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
	});

	it("returns true for the default agent dir when settings.json is absent", () => {
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("returns false when a custom agent dir is set", () => {
		process.env[ENV_AGENT_DIR] = tempDir;

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("returns false when settings.json already exists", () => {
		writeFileSync(settingsPath, "{}", "utf-8");

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});
});
