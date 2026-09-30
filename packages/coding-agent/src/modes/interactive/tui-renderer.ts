import type { Terminal } from "@candy/tui";
import { ProcessTerminal, TuiAltScreen } from "@candy/tui";
import { copyToClipboard } from "../../utils/clipboard.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { keycap, keyDisplayText } from "./components/keybinding-hints.ts";
import { theme } from "./theme/theme.ts";

export interface InteractiveTuiOptions {
	readonly showHardwareCursor: boolean;
	readonly logDirectory: string;
	readonly terminal?: Terminal;
	readonly onRightClickPaste?: () => void;
	readonly fullscreenCopyOnSelect?: boolean;
}

/** Composition root shared by coding-agent presentations. */
export function createInteractiveTui(options: InteractiveTuiOptions): TuiAltScreen {
	const terminal = options.terminal ?? new ProcessTerminal();
	const styleSearchMatch = (text: string) => theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
	return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {
		searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
		searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(styleSearchMatch(text))),
		searchNavigationButtonStyle: (text, hovered) => (hovered ? theme.underline(text) : text),
		searchKeycapStyle: keycap,
		scrollToEndIndicator: () => {
			const shortcut = keyDisplayText("tui.altScreen.bottom");
			const label =
				theme.fg("text", " ↓ Jump to latest message") +
				(shortcut ? ` · ${keycap(shortcut)}` : "") +
				theme.fg("text", " ");
			return theme.bg("selectedBg", label);
		},
		openUrl: openBrowser,
		onRightClickPaste: options.onRightClickPaste,
		copyOnSelect: options.fullscreenCopyOnSelect,
		copySelection: async (text) => {
			try {
				await copyToClipboard(text);
				return true;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
	});
}
