import { readFileSync } from "node:fs";
import { resetCapabilitiesCache, setCapabilities } from "@candy/tui";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { describe, expect, test } from "vitest";
import { SplashComponent, SplashTips } from "../src/modes/interactive/components/splash.ts";
import {
	SIXEL_HEIGHT_PX,
	SIXEL_SEQUENCE,
	SIXEL_WIDTH_PX,
	SPRITE_PALETTE,
} from "../src/modes/interactive/components/splash-logo.generated.ts";
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
	test("encodes every source pixel as an exact 4 by 4 Sixel block", () => {
		const source = PhotonImage.new_from_byteslice(
			new Uint8Array(readFileSync(new URL("../assets/candy-v3.png", import.meta.url))),
		);
		const sourcePixels = source.get_raw_pixels();
		expect(SIXEL_WIDTH_PX).toBe(source.get_width() * 4);
		expect(SIXEL_HEIGHT_PX).toBe(source.get_height() * 4);

		const pixels = new Int16Array(SIXEL_WIDTH_PX * SIXEL_HEIGHT_PX).fill(-1);
		const body = SIXEL_SEQUENCE.replace(/^\x1bP0;1;0q"1;1;\d+;\d+/, "")
			.replace(/#\d+;2;\d+;\d+;\d+/g, "")
			.replace(/\x1b\\$/, "");
		let x = 0;
		let y = 0;
		let color = 0;
		for (const match of body.matchAll(/#\d+|!\d+[?-~]|[?-~]|\$|-/g)) {
			const token = match[0];
			if (token === "$") {
				x = 0;
			} else if (token === "-") {
				x = 0;
				y += 6;
			} else if (token.startsWith("#")) {
				color = Number(token.slice(1));
			} else {
				const repeated = token.startsWith("!");
				const count = repeated ? Number(token.slice(1, -1)) : 1;
				const bits = token.charCodeAt(token.length - 1) - 63;
				for (let column = 0; column < count; column++, x++) {
					for (let bit = 0; bit < 6; bit++) {
						if ((bits & (1 << bit)) !== 0 && y + bit < SIXEL_HEIGHT_PX) {
							pixels[(y + bit) * SIXEL_WIDTH_PX + x] = color;
						}
					}
				}
			}
		}

		const colorIndex = new Map(SPRITE_PALETTE.map(([r, g, b], index) => [(r << 16) | (g << 8) | b, index]));
		for (let sy = 0; sy < source.get_height(); sy++) {
			for (let sx = 0; sx < source.get_width(); sx++) {
				const offset = (sy * source.get_width() + sx) * 4;
				const expected =
					sourcePixels[offset + 3] === 0
						? -1
						: colorIndex.get(
								(sourcePixels[offset] << 16) | (sourcePixels[offset + 1] << 8) | sourcePixels[offset + 2],
							);
				for (let dy = 0; dy < 4; dy++) {
					for (let dx = 0; dx < 4; dx++) {
						const actual = pixels[(sy * 4 + dy) * SIXEL_WIDTH_PX + sx * 4 + dx];
						if (actual !== expected)
							throw new Error(`Sixel pixel differs from source at ${sx},${sy} + ${dx},${dy}`);
					}
				}
			}
		}
	});

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
