/**
 * TUI session selector for --resume flag
 */

import { setKeybindings } from "@candy/tui";
import type { SessionInfo, SessionListProgress } from "../core/session-history.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.ts";
import { KeybindingsManager } from "../presentation/keybindings.ts";
import { createStartupTui, mountStartupContent, startStartupTui } from "./startup-ui.ts";

type SessionsLoader = (onProgress?: SessionListProgress, signal?: AbortSignal) => Promise<SessionInfo[]>;

/** Show TUI session selector and return selected session path or null if cancelled */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
	settingsManager: SettingsManager,
): Promise<string | null> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		let resolved = false;
		let close!: () => Promise<void>;
		const finish = async (path: string | null, exit = false) => {
			if (resolved) return;
			resolved = true;
			await close();
			selector.dispose();
			ui.stop();
			if (exit) process.exit(0);
			resolve(path);
		};

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			(path) => void finish(path),
			() => void finish(null),
			() => void finish(null, true),
			() => ui.requestRender(),
			{ showRenameHint: false, keybindings },
		);

		close = mountStartupContent(ui, settingsManager, selector);
		startStartupTui(ui, settingsManager);
	});
}
