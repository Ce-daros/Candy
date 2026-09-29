import { readFileSync } from "node:fs";
import { colorToHex } from "@candy/tui";
import { describe, expect, it } from "vitest";
import { getResolvedThemeColors, getThemeByName, initTheme } from "../src/modes/interactive/theme/theme.ts";

const palettes = {
	dark: {
		border: "#40e2ff",
		bashMode: "#ffd32f",
		accent: "#b967ff",
		success: "#b8e45a",
		error: "#f25d83",
		thinkingOff: "#515875",
		thinkingMax: "#cff9ff",
	},
	light: {
		border: "#007f99",
		bashMode: "#8a6400",
		accent: "#7641b0",
		success: "#567300",
		error: "#b72f54",
		thinkingOff: "#9198a8",
		thinkingMax: "#003f58",
	},
} as const;

describe("Candy theme palette", () => {
	for (const appearance of ["dark", "light"] as const) {
		it(`${appearance} maps semantic roles to the shared palette`, () => {
			const theme = getThemeByName(appearance)!;
			const json = JSON.parse(
				readFileSync(new URL(`../src/modes/interactive/theme/${appearance}.json`, import.meta.url), "utf8"),
			) as { vars: Record<string, string> };
			expect(Object.keys(json.vars)).toHaveLength(16);
			for (const [role, hex] of Object.entries(palettes[appearance])) {
				expect(colorToHex(theme.colors[role as keyof typeof palettes.dark])).toBe(hex);
			}
			expect(theme.colors.syntaxKeyword).toEqual(theme.colors.mdLink);
			expect(theme.colors.syntaxFunction).toEqual(theme.colors.warning);
			expect(theme.colors.syntaxVariable).toEqual(theme.colors.border);
			expect(theme.colors.syntaxString).toEqual(theme.colors.mdCode);
			expect(theme.colors.syntaxNumber).toEqual(theme.colors.success);
			expect(theme.colors.syntaxType).toEqual(theme.colors.accent);
		});
	}

	it("resolved export colors follow the selected theme", () => {
		initTheme("light");
		expect(getResolvedThemeColors().border).toBe(palettes.light.border);
		initTheme("dark");
		expect(getResolvedThemeColors().border).toBe(palettes.dark.border);
	});
});
