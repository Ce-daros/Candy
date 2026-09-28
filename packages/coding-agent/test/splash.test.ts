import { resetCapabilitiesCache, SixelImage, setCapabilities } from "@candy/tui";
import { describe, expect, test } from "vitest";
import { SplashComponent } from "../src/modes/interactive/components/splash.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function childrenOf(component: SplashComponent) {
	return (component as unknown as { children: unknown[] }).children;
}

describe("SplashComponent", () => {
	test("uses a SixelImage when the terminal supports sixel", () => {
		initTheme("dark");
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		try {
			const splash = new SplashComponent();
			expect(childrenOf(splash).some((child) => child instanceof SixelImage)).toBe(true);
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("falls back to the sprite renderer without image support", () => {
		initTheme("dark");
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		try {
			const splash = new SplashComponent();
			expect(childrenOf(splash).some((child) => child instanceof SixelImage)).toBe(false);
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("sprite fallback renders centered truecolor half-block lines", () => {
		initTheme("dark");
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		try {
			const splash = new SplashComponent();
			const lines = splash.render(60);
			const spriteLines = lines.filter((line) => line.includes("▀") || line.includes("▄"));
			expect(spriteLines.length).toBeGreaterThan(0);
			for (const line of spriteLines) {
				expect(line).toContain("\x1b[38;2;");
				const visible = stripAnsi(line);
				expect(visible.length).toBeLessThanOrEqual(60);
				// centered: leading whitespace, no trailing sprite content beyond the block
				expect(visible.startsWith(" ")).toBe(true);
			}
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("renders the baked sixel sequence line when supported", () => {
		initTheme("dark");
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		try {
			const splash = new SplashComponent();
			const lines = splash.render(60);
			expect(lines.some((line) => line.includes("\x1bP0;1;0q"))).toBe(true);
			// No half-block sprite glyphs in sixel mode
			expect(lines.every((line) => !line.includes("▀") && !line.includes("▄"))).toBe(true);
		} finally {
			resetCapabilitiesCache();
		}
	});
});
