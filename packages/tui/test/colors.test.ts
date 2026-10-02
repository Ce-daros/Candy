import assert from "node:assert";
import { describe, it } from "node:test";
import { colorToRgb, indexedColor, oklchColor, parseColor, rgbColor, styleText } from "../src/index.ts";

describe("colors", () => {
	it("parses hex and OKLCH colors and rejects everything else", () => {
		assert.deepStrictEqual(parseColor("#abc"), { kind: "rgb", r: 170, g: 187, b: 204 });
		assert.deepStrictEqual(parseColor("oklch(62% 0.1 200)"), { kind: "oklch", l: 0.62, c: 0.1, h: 200 });
		assert.throws(() => parseColor(""), /Invalid color value/);
		assert.throws(() => parseColor("red"), /Invalid color value/);
	});

	it("gamut-maps OKLCH to sRGB, including the lightness limits", () => {
		assert.deepStrictEqual(colorToRgb(oklchColor(0.627955, 0.257683, 29.2339)), { r: 255, g: 0, b: 0 });
		assert.deepStrictEqual(colorToRgb(oklchColor(1, 0.3, 150)), { r: 255, g: 255, b: 255 });
		assert.deepStrictEqual(colorToRgb(oklchColor(0, 0.3, 150)), { r: 0, g: 0, b: 0 });
	});

	it("styles text and closes sequences in reverse order", () => {
		assert.strictEqual(
			styleText("Ready", { fg: rgbColor(18, 52, 86), bg: indexedColor(9), bold: true, italic: true }, "truecolor"),
			"\x1b[38;2;18;52;86m\x1b[48;5;9m\x1b[1m\x1b[3mReady\x1b[23m\x1b[22m\x1b[49m\x1b[39m",
		);
		assert.match(styleText("Ready", { fg: rgbColor(18, 52, 86) }, "256color"), /^\x1b\[38;5;\d+mReady\x1b\[39m$/);
	});

	it("restores enclosing colors across multiple nesting levels", () => {
		for (const mode of ["truecolor", "256color"] as const) {
			const outer = { fg: indexedColor(8), bg: indexedColor(0) };
			const inner = { fg: indexedColor(6), bg: indexedColor(4) };
			const nested = styleText(`b${styleText("c", { fg: indexedColor(3) }, mode)}d`, inner, mode);
			assert.strictEqual(
				styleText(`a${nested}e`, outer, mode),
				"\x1b[38;5;8m\x1b[48;5;0ma\x1b[38;5;6m\x1b[48;5;4mb\x1b[38;5;3mc\x1b[38;5;6md\x1b[48;5;0m\x1b[38;5;8me\x1b[49m\x1b[39m",
			);
		}
	});

	it("restores enclosing attributes after their shared and individual resets", () => {
		assert.strictEqual(
			styleText(
				"a\x1b[22mb\x1b[23mc\x1b[24md\x1b[27me\x1b[29mf",
				{
					bold: true,
					dim: true,
					italic: true,
					underline: true,
					inverse: true,
					strikethrough: true,
				},
				"truecolor",
			),
			"\x1b[1m\x1b[2m\x1b[3m\x1b[4m\x1b[7m\x1b[9ma\x1b[1m\x1b[2mb\x1b[3mc\x1b[4md\x1b[7me\x1b[9mf\x1b[29m\x1b[27m\x1b[24m\x1b[23m\x1b[22m",
		);
	});

	it("reopens enclosing styles after full resets and leaves unrelated resets intact", () => {
		for (const reset of ["\x1b[0m", "\x1b[m"]) {
			assert.strictEqual(
				styleText(`a${reset}b\x1b[49mc`, { fg: indexedColor(8), bold: true }, "truecolor"),
				`\x1b[38;5;8m\x1b[1ma${reset}\x1b[38;5;8m\x1b[1mb\x1b[49mc\x1b[22m\x1b[39m`,
			);
		}
	});
});
