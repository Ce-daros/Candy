import { calculateSixelCellSize, resetCapabilitiesCache, setCapabilities, setCellDimensions } from "@candy/tui";
import xterm from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SplashComponent, SplashLogoComponent, SplashTips } from "../src/modes/interactive/components/splash.ts";
import {
	SIXEL_HEIGHT_PX,
	SIXEL_SEQUENCE,
	SIXEL_WIDTH_PX,
} from "../src/modes/interactive/components/splash-logo.generated.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const options = {
	version: "0.87.1",
	resources: { context: 1, skills: 8, prompts: 1, extensions: 2 },
	tipIndex: 0,
};

describe("SplashComponent", () => {
	beforeEach(() => setCellDimensions({ widthPx: 9, heightPx: 18 }));
	afterEach(() => {
		resetCapabilitiesCache();
		setCellDimensions({ widthPx: 9, heightPx: 18 });
	});
	test.each([null, "kitty", "iterm2"] as const)("omits the logo for protocol %s", (images) => {
		initTheme("dark");
		setCapabilities({ images, trueColor: true, hyperlinks: false });
		const lines = new SplashComponent(options).render(80);
		expect(lines.some((line) => line.includes(SIXEL_SEQUENCE))).toBe(false);
		expect(lines.some((line) => line.includes("▀") || line.includes("▄"))).toBe(false);
		expect(stripAnsi(lines.join("\n"))).toContain("Candy (0.87.1)");
	});

	test("renders the baked sixel sequence line when supported", () => {
		initTheme("dark");
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		try {
			const splash = new SplashComponent(options);
			const lines = splash.render(60);
			expect(lines.some((line) => line.includes("\x1bP0;1;0q"))).toBe(true);
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
			const tipBefore = stripAnsi(SplashTips.basic[options.tipIndex]());
			expect(stripAnsi(splash.render(100).join("\n"))).toContain(tipBefore);
			splash.setResources({ context: 0, skills: 0, prompts: 3, extensions: 0 });
			const output = stripAnsi(splash.render(100).join("\n"));
			expect(output).toContain("0 context · 0 skills · 3 prompts · 0 extensions");
			expect(output).toContain(tipBefore);
		} finally {
			resetCapabilitiesCache();
		}
	});

	test.each(["dark", "light"])("keeps every %s tip dim after its highlighted keycap", async (name) => {
		initTheme(name);
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const tips = [...SplashTips.basic, ...SplashTips.advanced, ...SplashTips.easter];
		for (const [tipIndex, tip] of tips.entries()) {
			const lines = new SplashComponent({ ...options, tipIndex }).render(160);
			const line = lines.find((value) => stripAnsi(value).trim() === stripAnsi(tip()));
			expect(line).toBeDefined();
			const terminal = new xterm.Terminal({ cols: 160, rows: 3, allowProposedApi: true });
			try {
				await new Promise<void>((resolve) =>
					terminal.write(`${line}\r\n${theme.fg("dim", "D")}${theme.fg("borderAccent", "K")}X`, resolve),
				);
				const rendered = terminal.buffer.active.getLine(0)!;
				const reference = terminal.buffer.active.getLine(1)!;
				const plain = rendered.translateToString(true);
				const keyStart = plain.indexOf("<");
				const keyEnd = plain.indexOf(">", keyStart);
				for (let column = plain.search(/\S/); column < plain.length; column++) {
					const expected = reference.getCell(column >= keyStart && column <= keyEnd ? 1 : 0)!;
					const actual = rendered.getCell(column)!;
					expect(actual.getFgColor(), `${name} tip ${tipIndex}, column ${column}`).toBe(expected.getFgColor());
					expect(actual.getFgColorMode()).toBe(expected.getFgColorMode());
				}
				expect(reference.getCell(2)!.isFgDefault()).toBe(true);
			} finally {
				terminal.dispose();
			}
		}
	});

	test("keeps the selected tip through resize", () => {
		initTheme("dark");
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		try {
			const splash = new SplashComponent(options);
			const tip = stripAnsi(SplashTips.basic[options.tipIndex]());
			const first = stripAnsi(splash.render(80).join("\n"));
			const resized = stripAnsi(splash.render(120).join("\n"));
			expect(first).toContain(tip);
			expect(resized).toContain(tip);
			splash.setAvailableHeight(12);
			expect(splash.render(80)).toHaveLength(12);
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("omits the logo and keeps metadata when available height is too small", () => {
		initTheme("dark");
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		try {
			const splash = new SplashComponent(options);
			splash.setAvailableHeight(12);
			const lines = splash.render(80);
			expect(lines).toHaveLength(12);
			expect(lines.some((line) => line.includes(SIXEL_SEQUENCE))).toBe(false);
			expect(lines.some((line) => line.includes("▀") || line.includes("▄"))).toBe(false);
			expect(stripAnsi(lines.join("\n"))).toContain("Candy (0.87.1)");
			expect(stripAnsi(lines.join("\n"))).toContain("1 context · 8 skills · 1 prompts · 2 extensions");
		} finally {
			resetCapabilitiesCache();
		}
	});
	test("hides and restores the logo at its calculated cell boundaries", () => {
		initTheme("dark");
		setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
		const logo = new SplashLogoComponent();
		const { columns, rows } = calculateSixelCellSize(SIXEL_WIDTH_PX, SIXEL_HEIGHT_PX);
		logo.setMaxHeight(rows);
		expect(logo.render(columns).some((line) => line.includes(SIXEL_SEQUENCE))).toBe(true);
		expect(logo.render(columns - 1)).toEqual([]);
		logo.setMaxHeight(rows - 1);
		expect(logo.render(columns)).toEqual([]);
		logo.setMaxHeight(rows);
		expect(logo.render(columns).some((line) => line.includes(SIXEL_SEQUENCE))).toBe(true);
		setCellDimensions({ widthPx: 14, heightPx: 28 });
		logo.invalidate();
		const resized = calculateSixelCellSize(SIXEL_WIDTH_PX, SIXEL_HEIGHT_PX);
		logo.setMaxHeight(resized.rows);
		expect(logo.render(resized.columns).some((line) => line.includes(SIXEL_SEQUENCE))).toBe(true);
	});
});
