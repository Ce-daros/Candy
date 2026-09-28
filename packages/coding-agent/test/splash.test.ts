import { resetCapabilitiesCache, setCapabilities } from "@candy/tui";
import { describe, expect, test } from "vitest";
import { SplashComponent, SplashTips } from "../src/modes/interactive/components/splash.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function childrenOf(component: SplashComponent) {
	return component;
}

const options = {
	version: "0.87.1",
	resources: { context: 1, skills: 8, prompts: 1, extensions: 2 },
	tipIndex: 0,
};

describe("SplashComponent", () => {
	test("uses a SixelImage when the terminal supports sixel", () => {
		initTheme("dark");
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		try {
			const splash = new SplashComponent(options);
			expect(
				childrenOf(splash)
					.render(80)
					.some((line) => line.includes("\x1bP0;1;0q")),
			).toBe(true);
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("falls back to the sprite renderer without image support", () => {
		initTheme("dark");
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		try {
			const splash = new SplashComponent(options);
			expect(
				childrenOf(splash)
					.render(80)
					.some((line) => line.includes("▀") || line.includes("▄")),
			).toBe(true);
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("sprite fallback renders centered truecolor half-block lines", () => {
		initTheme("dark");
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		try {
			const splash = new SplashComponent(options);
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
			const splash = new SplashComponent(options);
			const lines = splash.render(60);
			expect(lines.some((line) => line.includes("\x1bP0;1;0q"))).toBe(true);
			// No half-block sprite glyphs in sixel mode
			expect(lines.every((line) => !line.includes("▀") && !line.includes("▄"))).toBe(true);
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("shows version and all four resource counts, including zeros", () => {
		initTheme("dark");
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		try {
			const splash = new SplashComponent({
				version: "0.87.1",
				resources: { context: 0, skills: 2, prompts: 0, extensions: 1 },
				tipIndex: 0,
			});
			const output = stripAnsi(splash.render(100).join("\n"));
			expect(output).toContain("Candy (0.87.1)");
			expect(output).toContain("0 context · 2 skills · 0 prompts · 1 extensions");
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("refreshes resource counts without changing the selected tip", () => {
		initTheme("dark");
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		try {
			const splash = new SplashComponent(options);
			const tipBefore = stripAnsi(splash.render(100).join("\n"))
				.split("\n")
				.find((line) => line.includes("psst"));
			splash.setResources({ context: 0, skills: 0, prompts: 3, extensions: 0 });
			const output = stripAnsi(splash.render(100).join("\n"));
			expect(output).toContain("0 context · 0 skills · 3 prompts · 0 extensions");
			expect(output).toContain(tipBefore);
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("has ten basic, five advanced, and five easter-egg tips", () => {
		expect(SplashTips.basic).toHaveLength(10);
		expect(SplashTips.advanced).toHaveLength(5);
		expect(SplashTips.easter).toHaveLength(5);
	});

	test("renders no home actions and keeps the selected tip through resize", () => {
		initTheme("dark");
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		try {
			const splash = new SplashComponent({ ...options, tipIndex: 10 });
			const first = stripAnsi(splash.render(80).join("\n"));
			const resized = stripAnsi(splash.render(120).join("\n"));
			expect(first).toContain("shell output just for you? start with <!!>.");
			expect(resized).toContain("shell output just for you? start with <!!>.");
			expect(first).toContain("<!!>");
			expect(resized).toContain("<!!>");
			expect(first).not.toContain("History     Command     Hotkeys");
			splash.setAvailableHeight(12);
			expect(splash.render(80)).toHaveLength(12);
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("uses the sprite when the available height cannot fit the sixel logo", () => {
		initTheme("dark");
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		try {
			const splash = new SplashComponent(options);
			splash.setAvailableHeight(12);
			const lines = splash.render(80);
			expect(lines).toHaveLength(12);
			expect(lines.some((line) => line.includes("\x1bP0;1;0q"))).toBe(false);
			expect(lines.some((line) => line.includes("▀") || line.includes("▄"))).toBe(true);
			expect(stripAnsi(lines.join("\n"))).toContain("Candy (0.87.1)");
		} finally {
			resetCapabilitiesCache();
		}
	});
});
