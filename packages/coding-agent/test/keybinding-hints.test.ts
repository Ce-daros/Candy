import { setKeybindings } from "@candy/tui";
import { beforeEach, describe, expect, test } from "vitest";
import { keycap, keyHint, rawKeyHint } from "../src/modes/interactive/components/keybinding-hints.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { KeybindingsManager } from "../src/presentation/keybindings.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("keycaps in terminal hints", () => {
	beforeEach(() => setKeybindings(KeybindingsManager.create()));

	for (const appearance of ["dark", "light"] as const) {
		test(`colors the complete keycap cyan in ${appearance} theme`, () => {
			initTheme(appearance, false);
			const hint = keyHint("app.model.select", "model");
			const cap = stripAnsi(hint).match(/^<[^>]+>/)?.[0];
			expect(cap).toBeDefined();
			expect(hint).toContain(`${theme.getFgAnsi("borderAccent")}${cap}\x1b[39m`);
			expect(hint).toContain(`${theme.getFgAnsi("muted")} model\x1b[39m`);
		});
	}

	test("keeps a literal slash and alternatives inside separate keycaps", () => {
		initTheme("dark", false);
		expect(stripAnsi(keycap("/"))).toBe("</>");
		expect(stripAnsi(rawKeyHint("ctrl+z/ctrl+y", "undo or redo"))).toBe("<Ctrl+Z>/<Ctrl+Y> undo or redo");
	});
});
