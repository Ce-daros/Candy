import { getKeybindings } from "@candy/tui";
import { theme } from "../theme/theme.ts";

export type ListAction = "up" | "down" | "confirm" | "cancel";

/**
 * Shared key handling for hand-rendered list panels. Vertical lists may opt in
 * to the vim aliases; horizontal lists navigate with the editor cursor keys.
 */
export function readListAction(
	keyData: string,
	options?: { horizontal?: boolean; vim?: boolean },
): ListAction | undefined {
	const kb = getKeybindings();
	if (options?.horizontal) {
		if (kb.matches(keyData, "tui.editor.cursorLeft")) return "up";
		if (kb.matches(keyData, "tui.editor.cursorRight")) return "down";
	}
	if (kb.matches(keyData, "tui.select.up") || (options?.vim && keyData === "k")) return "up";
	if (kb.matches(keyData, "tui.select.down") || (options?.vim && keyData === "j")) return "down";
	if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") return "confirm";
	if (kb.matches(keyData, "tui.select.cancel")) return "cancel";
	return undefined;
}

/** Scroll position line for a paged list: "  (n/total)" in muted text; renders "  (0/0)" when empty. */
export function scrollCounter(selectedIndex: number, total: number): string {
	if (total <= 0) return theme.fg("muted", "  (0/0)");
	return theme.fg("muted", `  (${selectedIndex + 1}/${total})`);
}

/** Muted empty-state line with the shared two-space indent. */
export function emptyLine(message: string): string {
	return theme.fg("muted", `  ${message}`);
}
