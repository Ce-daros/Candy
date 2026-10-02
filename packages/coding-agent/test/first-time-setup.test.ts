import { resetCapabilitiesCache, setCapabilities, setCellDimensions } from "@candy/tui";
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
	beforeEach(() => {
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: false });
		setCellDimensions({ widthPx: 9, heightPx: 18 });
	});
	afterEach(() => resetCapabilitiesCache());
	it("shows the original logo only when its complete pixel footprint fits", () => {
		const full = new SplashLogoComponent().render(80);
		const compact = new SplashLogoComponent(8).render(80);
		const tiny = new SplashLogoComponent(1).render(80);
		expect(full).toHaveLength(16);
		expect(compact).toEqual([]);
		expect(tiny).toEqual([]);
		expect(new SplashLogoComponent().render(57)).toEqual([]);
	});

	it("keeps theme choices visible and shows or hides the logo after a resize", () => {
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
		expect(compact.some((line) => line.includes("\x1bP0;1;0q"))).toBe(true);
		expect(stripAnsi(compact.join("\n"))).toContain("Light");
		setup.handleInput("\n");
		expect(submitted).toEqual({ theme: "dark" });
		height = 45;
		expect(setup.render(160).length).toBeGreaterThan(compact.length);
		height = 20;
		const small = setup.render(80);
		expect(small.some((line) => line.includes("\x1bP0;1;0q"))).toBe(false);
		expect(stripAnsi(small.join("\n"))).toContain("Light");
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
