import {
	CURSOR_MARKER,
	ProcessTerminal,
	setCapabilityOverrides,
	setKeybindings,
	type TUI,
	TuiMainScreen,
} from "@candy/tui";
import { existsSync } from "fs";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir, getSettingsPath, PACKAGE_NAME } from "../config.ts";
import { DefaultPackageManager, type ResolvedResource } from "../core/package-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import type { ProjectTrustSelection, ProjectTrustStoreEntry } from "../core/trust-manager.ts";
import type { PanelContent } from "../modes/interactive/components/composer-panel.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../modes/interactive/components/first-time-setup.ts";
import { PanelTransition, panelPhase, panelRowVisible } from "../modes/interactive/components/panel-transition.ts";
import { TrustSelectorComponent } from "../modes/interactive/components/trust-selector.ts";
import {
	detectTerminalBackgroundFromEnv,
	detectTerminalThemeForAuto,
	initTheme,
	loadThemeFromPath,
	parseAutoThemeSetting,
	resolveThemeSetting,
	setRegisteredThemes,
	setTheme,
	type Theme,
} from "../modes/interactive/theme/theme.ts";
import { KeybindingsManager } from "../presentation/keybindings.ts";

const OFFICIAL_PACKAGE_NAME = "@candy/coding-agent";
const OFFICIAL_APP_NAME = "candy";
const OFFICIAL_CONFIG_DIR_NAME = ".candy";

interface DistributionMetadata {
	packageName: string;
	appName: string;
	configDirName: string;
}

function isOfficialDistribution({ packageName, appName, configDirName }: DistributionMetadata): boolean {
	return (
		packageName === OFFICIAL_PACKAGE_NAME &&
		appName === OFFICIAL_APP_NAME &&
		configDirName === OFFICIAL_CONFIG_DIR_NAME
	);
}

function loadThemes(resources: ResolvedResource[]): Theme[] {
	const themes: Theme[] = [];
	const seen = new Set<string>();
	for (const resource of resources) {
		if (!resource.enabled) continue;
		try {
			const loadedTheme = loadThemeFromPath(resource.path);
			if (loadedTheme.name) {
				if (seen.has(loadedTheme.name)) continue;
				seen.add(loadedTheme.name);
			}
			themes.push(loadedTheme);
		} catch {
			// Startup prompts should not fail because a theme is broken. The normal
			// resource loader reports theme diagnostics later in startup.
		}
	}
	return themes;
}

async function loadStartupThemes(settingsManager: SettingsManager): Promise<Theme[]> {
	const globalSettingsManager = SettingsManager.inMemory(settingsManager.getGlobalSettings(), {
		projectTrusted: false,
	});
	const packageManager = new DefaultPackageManager({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		settingsManager: globalSettingsManager,
	});
	const resolvedPaths = await packageManager.resolve(async () => "skip");
	return loadThemes(resolvedPaths.themes);
}

export async function createStartupTui(settingsManager: SettingsManager): Promise<TUI> {
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	setRegisteredThemes(await loadStartupThemes(settingsManager));
	const terminalTheme = detectTerminalBackgroundFromEnv().theme;
	initTheme(resolveThemeSetting(settingsManager.getThemeSetting(), terminalTheme) ?? terminalTheme);
	setKeybindings(KeybindingsManager.create());
	const ui: TUI = new TuiMainScreen(
		new ProcessTerminal(),
		settingsManager.read("show-hardware-cursor"),
		getAgentDir(),
	);
	ui.setClearOnShrink(settingsManager.read("clear-on-shrink"));
	return ui;
}

export function startStartupTui(ui: TUI, settingsManager: SettingsManager): void {
	ui.start();
	void applyDetectedStartupTheme(ui, settingsManager);
}

async function applyDetectedStartupTheme(ui: TUI, settingsManager: SettingsManager): Promise<void> {
	const themeSetting = settingsManager.getThemeSetting();
	if (themeSetting && !parseAutoThemeSetting(themeSetting)) return;

	const terminalTheme = await detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
	setTheme(resolveThemeSetting(themeSetting, terminalTheme) ?? terminalTheme);
	ui.invalidate();
	ui.requestRender();
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

export function mountStartupContent(ui: TUI, settings: SettingsManager, content: PanelContent): () => Promise<void> {
	const transition = new PanelTransition(() => ui.requestRender());
	transition.setOptions(settings.read("ui-animations"), settings.read("animation-intensity"));
	let pending = true;
	let closing = false;
	let displayed: string[] = [];
	let outgoing: string[] = [];
	let shownRows = new Set<number>();
	ui.addChild({
		invalidate: () => {
			if (!closing) content.invalidate();
		},
		handleMouse: (event) => {
			if (closing || !shownRows.has(event.y)) return;
			return content.handleMouse?.(event);
		},
		render: (width) => {
			if (pending) {
				pending = false;
				transition.setOpen(true);
			}
			if (!closing) content.setAvailableHeight?.(ui.terminal.rows);
			const lines = (closing ? outgoing : content.render(width)).slice(0, ui.terminal.rows);
			const progress = transition.value();
			const { growth } = panelPhase(progress);
			const height =
				closing && progress === 0
					? 0
					: Math.min(lines.length, Math.max(2, Math.round(2 + (lines.length - 2) * growth)));
			shownRows = new Set<number>();
			displayed = Array.from({ length: height }, (_, row) => {
				if (!panelRowVisible(progress, row, lines.length, 0.73)) return "";
				shownRows.add(row);
				return lines[row]!;
			});
			return displayed;
		},
	});
	ui.setFocus(content);
	return () =>
		new Promise((resolve) => {
			pending = false;
			closing = true;
			outgoing = displayed.map((line) => line.replaceAll(CURSOR_MARKER, ""));
			ui.setFocus(null);
			transition.setOpen(false, () => {
				outgoing = [];
				transition.dispose();
				resolve();
			});
		});
}

/**
 * First-time setup runs when all of these hold:
 * - this is the official candy distribution (not a fork/rebrand)
 * - the default agent directory is used (no custom agent dir override)
 * - setup was not completed before (settings.json does not exist)
 */
export function shouldRunFirstTimeSetup(settingsPath: string = getSettingsPath()): boolean {
	if (
		!isOfficialDistribution({
			packageName: PACKAGE_NAME,
			appName: APP_NAME,
			configDirName: CONFIG_DIR_NAME,
		})
	) {
		return false;
	}
	if (process.env[ENV_AGENT_DIR]) {
		return false;
	}
	return !existsSync(settingsPath);
}

/**
 * Mount a component on a one-off startup TUI and resolve when it completes; the
 * TUI is torn down either way. `open` returns an optional cleanup run before teardown.
 */
async function withStartupTui<T>(
	settingsManager: SettingsManager,
	open: (ui: TUI, done: (value: T | undefined) => void) => (() => void | Promise<void>) | undefined,
): Promise<T | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		let cleanup: (() => void | Promise<void>) | undefined;
		const finish = (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			void (async () => {
				await cleanup?.();
				await clearStartupTui(ui);
				ui.stop();
				resolve(result);
			})();
		};
		cleanup = open(ui, finish) ?? undefined;
	});
}

export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
): Promise<T | undefined> {
	return withStartupTui<T>(settingsManager, (ui, done) => {
		const selector = new ExtensionSelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => done(options.find((entry) => entry.label === option)?.value),
			() => done(undefined),
			{ tui: ui, getAvailableHeight: () => Math.floor(ui.terminal.rows * 0.8) },
		);
		const close = mountStartupContent(ui, settingsManager, selector);
		startStartupTui(ui, settingsManager);
		return async () => {
			await close();
			selector.dispose();
		};
	});
}

/** Show the project trust selector on a startup TUI; resolves with the decision, or undefined on cancel. */
export async function showStartupTrustSelector(
	settingsManager: SettingsManager,
	cwd: string,
	savedDecision: ProjectTrustStoreEntry | null,
): Promise<ProjectTrustSelection | undefined> {
	return withStartupTui<ProjectTrustSelection>(settingsManager, (ui, done) => {
		const selector = new TrustSelectorComponent({
			cwd,
			savedDecision,
			projectTrusted: false,
			onSelect: done,
			onCancel: () => done(undefined),
		});
		const close = mountStartupContent(ui, settingsManager, selector);
		startStartupTui(ui, settingsManager);
		return close;
	});
}

/** Show the first-time setup dialog and persist the result */
export async function showFirstTimeSetup(settingsManager: SettingsManager): Promise<void> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		let close: (() => Promise<void>) | undefined;
		const finish = async (result: FirstTimeSetupResult | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			if (result) {
				await settingsManager.commitSetting("global", "theme", result.theme);
			}
			await close?.();
			await clearStartupTui(ui);
			ui.stop();
			resolve();
		};

		const showSetup = async () => {
			ui.start();
			const detectedTheme = await detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
			setTheme(detectedTheme);
			const component = new FirstTimeSetupComponent({
				detectedTheme,
				getAvailableHeight: () => ui.terminal.rows,
				onThemePreview: (themeName) => {
					setTheme(themeName);
					ui.requestRender();
				},
				onSubmit: (result) => void finish(result),
				onCancel: () => void finish(undefined),
			});
			close = mountStartupContent(ui, settingsManager, component);
			ui.requestRender();
		};

		void showSetup();
	});
}

export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	return withStartupTui<string>(settingsManager, (ui, done) => {
		const input = new ExtensionInputComponent(title, placeholder, done, () => done(undefined), {
			tui: ui,
		});
		const close = mountStartupContent(ui, settingsManager, input);
		startStartupTui(ui, settingsManager);
		return async () => {
			await close();
			input.dispose();
		};
	});
}
