/**
 * TUI config selector for `candy config` command
 */

import { ProcessTerminal, type TUI, TuiMainScreen } from "@candy/tui";
import type { ResourceConfiguration } from "../core/resource-configuration.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ConfigSelectorComponent, type ScopedResolvedPaths } from "../modes/interactive/components/config-selector.ts";
import { initTheme, stopThemeWatcher } from "../modes/interactive/theme/theme.ts";
import { mountStartupContent } from "./startup-ui.ts";

export interface ConfigSelectorOptions {
	resolvedPaths: ScopedResolvedPaths;
	settingsManager: SettingsManager;
	cwd: string;
	agentDir: string;
	writeScope: "global" | "project";
	projectModeAvailable: boolean;
	resourceConfiguration: ResourceConfiguration;
}

/** Show TUI config selector and return when closed */
export async function selectConfig(options: ConfigSelectorOptions): Promise<void> {
	// Initialize theme before showing TUI
	initTheme(options.settingsManager.getTheme(), true);

	return new Promise((resolve) => {
		const ui: TUI = new TuiMainScreen(
			new ProcessTerminal(),
			options.settingsManager.read("show-hardware-cursor"),
			options.agentDir,
		);
		ui.setClearOnShrink(options.settingsManager.read("clear-on-shrink"));
		let resolved = false;
		let close!: () => Promise<void>;
		const finish = async (exit = false) => {
			if (resolved) return;
			resolved = true;
			await close();
			ui.stop();
			stopThemeWatcher();
			if (exit) process.exit(0);
			resolve();
		};

		const selector = new ConfigSelectorComponent(
			options.resolvedPaths,
			options.settingsManager,
			options.cwd,
			options.agentDir,
			() => void finish(),
			() => void finish(true),
			() => ui.requestRender(),
			ui.terminal.rows,
			options.writeScope,
			options.projectModeAvailable,
			() => Math.floor(ui.terminal.rows * 0.8),
			{ resourceConfiguration: options.resourceConfiguration },
		);

		close = mountStartupContent(ui, options.settingsManager, selector);
		ui.start();
	});
}
