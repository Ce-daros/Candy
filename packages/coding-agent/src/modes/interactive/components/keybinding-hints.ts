/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@candy/tui";
import { theme } from "../theme/theme.ts";
import { formatKeycap, formatKeyText, type KeyTextFormatOptions } from "./keycap-format.ts";

export { formatKeyText, type KeyTextFormatOptions } from "./keycap-format.ts";

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

export function keycap(key: string): string {
	return formatKeycap(key, (text) => theme.fg("borderAccent", text));
}

export function keyHint(keybinding: Keybinding, description: string): string {
	return keycap(keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	return keycap(key) + theme.fg("muted", ` ${description}`);
}
