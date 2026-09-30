/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@candy/agent-core";
import type { AssistantMessage, AuthEvent, AuthPrompt, ImageContent, Message, Model } from "@candy/ai";
import type * as TuiLayouts from "@candy/tui";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	EditorComponent,
	Keybinding,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
} from "@candy/tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	decodeKittyPrintable,
	getImageDimensions,
	matchesKey,
	Spacer,
	setCapabilityOverrides,
	setKeybindings,
	type Terminal,
	Text,
	type TUI,
	type TuiAltScreen,
	visibleWidth,
} from "@candy/tui";
import chalk from "chalk";
import { spawn } from "child_process";
import {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	getAgentDir,
	getAuthPath,
	getDebugLogPath,
	VERSION,
} from "../../config.ts";
import type { Theme } from "../../contracts/theme.ts";
import {
	type AgentSession,
	type AgentSessionEvent,
	parseSkillBlock,
	type QueuedInput,
} from "../../core/agent-session.ts";
import { type AgentSessionRuntime, SessionImportFileNotFoundError } from "../../core/agent-session-runtime.ts";
import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.ts";
import {
	CACHE_TTL_MS,
	type CacheMiss,
	collectCacheMisses,
	computeCacheWaste,
	detectCacheMiss,
} from "../../core/cache-stats.ts";
import { formatCacheWarmingStatus, formatCacheWarmingUsage } from "../../core/cache-warmer.ts";
import { DEFAULT_THINKING_LEVEL } from "../../core/defaults.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionCommandContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	MarkdownTransformer,
	ProjectTrustContext,
	UserBashEventResult,
} from "../../core/extensions/index.ts";
import { findExtensionStackMatches } from "../../core/extensions/stack-matches.ts";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import { createCompactionSummaryMessage, createCustomMessage } from "../../core/messages.ts";
import { CredentialSynchronizationError } from "../../core/model-runtime.ts";
import { DefaultPackageManager } from "../../core/package-manager.ts";
import { getQuickSelectionModels, reconcileQuickSelection } from "../../core/quick-selection.ts";
import type { ResourceDiagnostic } from "../../core/resource-loader.ts";
import { createSessionCommandActions } from "../../core/session-command-actions.ts";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.ts";
import { type SessionEntry, SessionManager, type UsageEntry } from "../../core/session-manager.ts";
import type { FullscreenExitOutput } from "../../core/settings-manager.ts";
import { commitInteractiveSetting, getInteractiveSettingState } from "../../core/settings-operations.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import type { TruncationResult } from "../../core/tools/truncate.ts";
import {
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	type ProjectTrustStoreEntry,
} from "../../core/trust-manager.ts";
import { getUsageCostBreakdown } from "../../core/usage-totals.ts";
import { type AppKeybinding, KEYBINDINGS, KeybindingsManager } from "../../presentation/keybindings.ts";
import { exportSessionHtml } from "../../presentation/session-html-export.ts";
import { withBuiltInRenderers } from "../../presentation/tool-renderers/index.ts";
import { getChangelogPath, getNewEntries, normalizeChangelogLinks, parseChangelog } from "../../utils/changelog.ts";
import { copyToClipboard, readClipboardText } from "../../utils/clipboard.ts";
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.ts";
import { parseGitUrl } from "../../utils/git.ts";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";
import { getCwdRelativePath, resolvePath } from "../../utils/paths.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { loadAllHighlightLanguages } from "../../utils/syntax-highlight.ts";
import { ensureTool, type ToolStatus } from "../../utils/tools-manager.ts";
import { createChatViewport } from "./chat-viewport.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import type { CommandPanelAction } from "./components/command-panel.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { ComposerPanel } from "./components/composer-panel.ts";
import { ConfigSelectorComponent } from "./components/config-selector.ts";
import { CustomEditor, type EditorBottomStatus } from "./components/custom-editor.ts";
import { CustomEntryComponent } from "./components/custom-entry.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { FooterComponent, formatTokens, modelDisplayName } from "./components/footer.ts";
import type { InputMode } from "./components/frame-motion.ts";
import { HelpPanel } from "./components/help-panel.ts";
import { keycap, keyDisplayText, keyHint } from "./components/keybinding-hints.ts";
import { type LoadedResourceSection, LoadedResourcesComponent } from "./components/loaded-resources.ts";
import { LoginDialogComponent } from "./components/login-dialog.ts";
import { createMermaidCodeBlockView } from "./components/mermaid.ts";
import {
	type AuthSelectorProvider,
	getAuthSelectorProviders,
	OAuthSelectorComponent,
} from "./components/oauth-selector.ts";
import type { PowerbarHost, PowerbarModelEntry, PowerbarSnapshot } from "./components/powerbar.ts";
import { QueuedMessagesComponent } from "./components/queued-messages.ts";
import { ReadingPanelComponent, type ReadingPanelRow } from "./components/reading-panel.ts";
import { SessionSelectorComponent } from "./components/session-selector.ts";
import { createSettingsDefinition, cycleSetting } from "./components/settings-definition.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import { SplashComponent, type SplashResources } from "./components/splash.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	RetryStatusIndicator,
	type StatusIndicator,
	WorkingStatusIndicator,
} from "./components/status-indicator.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { TopBarComponent } from "./components/top-bar.ts";
import { TranscriptContainer } from "./components/transcript-container.ts";
import { TranscriptNotice } from "./components/transcript-notice.ts";
import { TransientNotification } from "./components/transient-notification.ts";
import { TreeSelectorComponent } from "./components/tree-selector.ts";
import { type TrustSelection, TrustSelectorComponent } from "./components/trust-selector.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { UserMessageSelectorComponent } from "./components/user-message-selector.ts";
import { ExtensionWidgetAdapter } from "./extension-widget-adapter.ts";
import { editInExternalEditor } from "./external-editor.ts";
import { InteractivePageController } from "./interactive-page-controller.ts";
import { InteractivePresentation, type PresentationSurface } from "./interactive-presentation.ts";
import {
	type CompactionCostNotice,
	isCompactionCostNotice,
	isCustomSessionEntry,
	isUsageSessionEntry,
	type RenderSessionItem,
	SessionPresentation,
} from "./session-presentation.ts";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	onThemeChange,
	setRegisteredThemes,
	stopThemeWatcher,
	theme,
} from "./theme/theme.ts";
import { InteractiveThemeController } from "./theme/theme-controller.ts";
import { createInteractiveTui } from "./tui-renderer.ts";

export { createInteractiveTui } from "./tui-renderer.ts";

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

interface WorkingStatusEditor extends EditorComponent {
	readonly embedWorkingStatus: boolean;
	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void;
}

function isWorkingStatusEditor(editor: EditorComponent): editor is WorkingStatusEditor {
	return (
		"embedWorkingStatus" in editor &&
		editor.embedWorkingStatus === true &&
		"setWorkingStatusIndicator" in editor &&
		typeof editor.setWorkingStatusIndicator === "function"
	);
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

function omitImageMarkers(text: string): string {
	return text.replace(/\[Image #\d+(?: [^\]]*)?\]/g, "").trim();
}

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

export function formatCrashExtensionHint(extensionMatches: readonly string[] | undefined): string | undefined {
	const matches = Array.isArray(extensionMatches)
		? extensionMatches.filter((match): match is string => typeof match === "string" && match.length > 0)
		: [];
	if (matches.length === 0) return undefined;
	const quoted = matches.map((match) => `\`${match}\``);
	const labels =
		quoted.length === 1
			? quoted[0]
			: quoted.length === 2
				? quoted.join(" and ")
				: `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
	const noun = matches.length === 1 ? "extension" : "extensions";
	const pronoun = matches.length === 1 ? "it" : "them";
	return `A stack frame came from loaded ${noun} ${labels}, which may be involved. Try disabling ${pronoun} with \`${APP_NAME} config\`, or run \`${APP_NAME} -ne\` to confirm.`;
}

const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage. Disable this warning in Command settings.";

function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parsePathCommandArgument(input: string): string | undefined {
	const value = input.trim();
	if (!value) return undefined;
	const quote = value[0];
	if (quote === '"' || quote === "'") {
		if (value.length < 2 || value.at(-1) !== quote) throw new Error("Close the path quote");
		return value.slice(1, -1);
	}
	return value;
}

export function formatResumeCommand(sessionManager: SessionManager): string | undefined {
	if (!process.stdout.isTTY) return undefined;
	if (!sessionManager.isPersisted()) return undefined;

	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;

	const args = [APP_NAME];
	if (!sessionManager.usesDefaultSessionDir()) {
		args.push("--session-dir", quoteIfNeeded(sessionManager.getSessionDir()));
	}
	args.push("--session", sessionManager.getSessionId());
	return args.join(" ");
}

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Diagnostics collected before the interactive TUI was initialized. */
	startupDiagnostics?: AgentSessionRuntimeDiagnostic[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Cwd to trust after reload if it gained a .candy directory during this implicitly trusted session. */
	autoTrustOnReloadCwd?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
	/** Initial interactive theme setting for this invocation. */
	initialThemeSetting?: string;
	/** Terminal implementation. Defaults to the current process terminal. */
	terminal?: Terminal;
}

export class InteractiveMode {
	private runtimeHost: AgentSessionRuntime;
	private readonly topBar = new TopBarComponent(
		() => ({
			project: path.basename(this.sessionManager.getCwd()),
			branch: this.footerDataProvider.getGitBranch(),
			sessionName: this.sessionManager.getSessionName(),
			contextPercent: this.session.getContextUsage()?.percent ?? null,
		}),
		() => this.renderer.requestRender(),
	);
	private readonly renderer: TuiAltScreen;
	private loadedResourcesContainer: Container;
	private chatContainer: TranscriptContainer;
	private splashComponent: SplashComponent | undefined;
	private documentContainer: Container;
	private transcriptScrollView: TuiLayouts.ScrollView | undefined;
	private fullscreenLayoutRoot: Component | undefined;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private notification: TransientNotification;
	private defaultEditor: CustomEditor;
	private composerPanel: ComposerPanel;
	private helpPanel: HelpPanel | undefined;
	private transcriptSearch: Component | undefined;
	private readonly pageController: InteractivePageController;
	private editor: EditorComponent;
	private editorComponentFactory: EditorFactory | undefined;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | undefined;
	private editorContainer: Container;
	private footer: FooterComponent;
	private footerContainer: Container;
	private footerDataProvider: FooterDataProvider;
	private lastContextPercent: number | null | undefined;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (input: QueuedInput) => void;
	private pendingUserInputs: QueuedInput[] = [];
	private activeStatusIndicator: StatusIndicator | undefined = undefined;
	private activeWorkingIndicatorEmbedded = false;
	private workingVisible = true;
	private readonly defaultWorkingMessage = "Working";
	private readonly defaultHiddenThinkingLabel = "Thinking...";
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;
	private startupNoticesShown = false;
	private anthropicSubscriptionWarningShown = false;

	// Status line tracking (for mutating immediately-sequential status updates)
	private managedToolStatusStarted = false;

	// Streaming message tracking
	private readonly sessionPresentation = new SessionPresentation();

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;
	private outputPad = 1;
	private readonly mermaidCodeBlockView = createMermaidCodeBlockView({
		getMode: () => this.settingsManager.getMermaidRenderingMode(),
		theme,
	});

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;
	private signalCleanupHandlers: Array<() => void> = [];

	private inputMode: InputMode = "normal";
	private readonly presentation: InteractivePresentation;
	private powerbarReturn: PowerbarSnapshot | undefined;
	private activeLogin?: { dialog: LoginDialogComponent; session: AgentSession };

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	private retryEscapeHandler?: () => void;

	// Messages queued while compaction is running

	// Shutdown state
	private shutdownRequested = false;

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputSubscriptions = new Set<{
		handler: (data: string) => { consume?: boolean; data?: string } | undefined;
		unsubscribe: () => void;
	}>();

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetAdapter!: ExtensionWidgetAdapter;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	private builtInHeader: Component | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	private options: InteractiveModeOptions;
	private readonly onRightClickPaste = (): void => {
		void this.handleRightClickPaste();
	};
	private autoTrustOnReloadCwd: string | undefined;
	private themeController: InteractiveThemeController;

	// Convenience accessors
	private get session(): AgentSession {
		return this.runtimeHost.session;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}

	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
		this.runtimeHost = runtimeHost;
		setCapabilityOverrides(this.settingsManager.getTerminalCapabilityOverrides());
		this.options = { ...options };
		this.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.resetExtensionUI();
		});
		this.runtimeHost.setRebindSession(async () => {
			await this.rebindCurrentSession({ renderBeforeBind: true });
			await this.themeController.applyFromSettings();
		});
		this.version = VERSION;
		this.renderer = createInteractiveTui({
			showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
			logDirectory: getAgentDir(),
			terminal: options.terminal,
			onRightClickPaste: this.onRightClickPaste,
			fullscreenCopyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
		});
		this.renderer.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.loadedResourcesContainer = new Container();
		this.chatContainer = new TranscriptContainer();
		this.documentContainer = new Container();
		this.documentContainer.addChild(this.headerContainer);
		this.documentContainer.addChild(this.loadedResourcesContainer);
		this.documentContainer.addChild(this.chatContainer);

		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.notification = new TransientNotification(
			() => this.renderer.requestRender(),
			() => this.settingsManager.getUiAnimations(),
		);
		this.statusContainer.addChild(this.notification);
		this.extensionWidgetAdapter = new ExtensionWidgetAdapter(this.renderer);
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.renderer, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
			embedWorkingStatus: true,
		});
		this.editor = this.defaultEditor;
		this.composerPanel = new ComposerPanel(this.renderer, this.defaultEditor);
		this.composerPanel.setOptions(
			this.settingsManager.getUiAnimations(),
			this.settingsManager.getAnimationIntensity(),
		);
		this.topBar.setAnimations(this.settingsManager.getUiAnimations());
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.buildPowerbarHost());
		this.defaultEditor.setBottomStatus(this.footer);
		this.defaultEditor.setAnimationOptions(
			this.settingsManager.getUiAnimations(),
			this.settingsManager.getAnimationIntensity(),
		);
		this.footer.setAnimationOptions(
			this.settingsManager.getUiAnimations(),
			this.settingsManager.getAnimationIntensity(),
		);
		this.footerContainer = new Container();

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.outputPad = this.settingsManager.getOutputPad();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.themeController = new InteractiveThemeController(this.renderer, {
			getSettingsManager: () => this.settingsManager,
			showError: (message) => this.showError(message),
			onChanged: () => this.updateEditorBorderColor(),
			initialThemeSetting: options.initialThemeSetting,
		});
		this.presentation = this.createPresentation();
		this.pageController = new InteractivePageController({
			suspendPresentation: (content) => this.presentation.suspendFor(content),
			closeTranscriptSearch: (content) => {
				if (this.transcriptSearch && content !== this.transcriptSearch) this.renderer.closeSearch();
			},
			mount: (content, heightRatio, inputTarget) => {
				this.composerPanel.show(content, heightRatio, inputTarget);
				this.editorContainer.clear();
				this.editorContainer.addChild(this.composerPanel);
				this.renderer.setFocus(this.composerPanel);
			},
			resumePresentation: () => this.presentation.resume(),
			focusEditor: () => this.renderer.setFocus(this.editor),
			closeAnimation: (onComplete) => this.composerPanel.close(onComplete),
			restoreEditor: () => {
				this.editorContainer.clear();
				if (this.inputMode === "help" && this.helpPanel) this.editorContainer.addChild(this.helpPanel);
				this.editorContainer.addChild(this.editor);
				this.renderer.setFocus(this.editor);
			},
			requestRender: () => this.renderer.requestRender(),
		});
	}

	private createBaseAutocompleteProvider(): AutocompleteProvider {
		return new CombinedAutocompleteProvider(this.sessionManager.getCwd(), this.fdPath);
	}

	private async completeCommandArguments(
		input: string,
		signal: AbortSignal,
		force = false,
	): Promise<AutocompleteItem[] | null> {
		const provider = this.createBaseAutocompleteProvider();
		const suggestions = await provider.getSuggestions([input], 0, input.length, { signal, force });
		return (
			suggestions?.items.map((item) => ({
				...item,
				value: provider.applyCompletion([input], 0, input.length, item, suggestions.prefix).lines[0]!,
			})) ?? null
		);
	}

	private openPresentation(surface: PresentationSurface, model?: Model<any>): void {
		this.cancelActiveLogin();
		this.pageController.disposeActiveSelector();
		if (surface === "command") {
			this.setInputMode("command");
		} else {
			if (this.footer.isPowerbarIdle()) {
				if (surface === "history" || surface === "agent") this.footer.openPowerbarThinking();
				else this.footer.openPowerbarModelBrowse();
			}
			this.powerbarReturn = this.footer.suspendPowerbar();
		}
		this.presentation.open(surface, model);
	}

	private createPresentation(): InteractivePresentation {
		return new InteractivePresentation({
			session: () => this.session,
			settings: () => this.settingsManager,
			mount: (panel) => this.pageController.mountPanel(panel),
			exit: () => {
				this.pageController.disposeActiveSelector();
				this.setInputMode("normal");
				this.pageController.closePanel();
				if (this.powerbarReturn) {
					this.footer.restorePowerbar(this.powerbarReturn);
					this.powerbarReturn = undefined;
				}
			},
			render: () => this.renderer.requestRender(),
			read: (title, content, onEdit) => this.showReader(title, content, undefined, onEdit),
			reportError: (message) => this.showError(message),
			applyQuickSelection: (signal) => this.applyQuickSelection(signal),
			edit: (title, content) =>
				this.showExtensionEditor(title, content, () =>
					this.session.isStreaming || this.session.isCompacting
						? "Wait for the current response or compaction to finish"
						: undefined,
				),
			login: (provider) => this.handleLoginCommand(provider),
			skills: () => this.showSkillConfiguration(),
			settingsActions: () => {
				const definition = this.buildSettingsDefinition(() => this.pageController.closePanel());
				return [
					...definition.items.map((item): CommandPanelAction => {
						const cycle = async (direction: 1 | -1): Promise<void> => {
							await cycleSetting(definition, item.id, direction);
							this.presentation.resume();
						};
						return {
							id: `setting:${item.id}`,
							name: item.label,
							description: item.currentValue,
							argumentMode: "none",
							cycle: item.values ? cycle : undefined,
							execute: item.values
								? () => cycle(1)
								: async () =>
										this.pageController.showSelector((done) => {
											const control = item.submenu!(item.currentValue, async (selectedValue) => {
												if (selectedValue !== undefined && item.id === "theme") {
													await definition.onChange(item.id, selectedValue);
												}
												done();
											});
											return { component: control, focus: control };
										}),
						};
					}),
					{
						id: "setting:project-trust",
						name: "Project trust",
						source: "Settings · Privacy & Trust",
						argumentMode: "none",
						execute: async () => this.showTrustSelector(),
					},
				];
			},
			localCommands: () => this.getLocalCommandActions(),
			historyCommands: () => this.getHistoryCommandActions(),
			completeArguments: (input, signal, force) => this.completeCommandArguments(input, signal, force),
			historyAction: async (action, args) => {
				switch (action) {
					case "compact":
						await this.handleCompactCommand(args || undefined);
						break;
					case "details":
						this.handleSessionCommand();
						break;
					case "rename":
						this.handleNameCommand(args);
						break;
					case "tree":
						this.showTreeSelector();
						break;
					case "fork":
						this.showUserMessageSelector();
						break;
					case "clone":
						await this.handleCloneCommand();
						break;
					case "resume":
						this.showSessionSelector();
						break;
				}
			},
		});
	}

	private getHistoryCommandActions(): CommandPanelAction[] {
		const resolveArgument = (args: string): string | undefined => {
			const parsed = parsePathCommandArgument(args);
			return parsed === undefined ? undefined : resolvePath(parsed, this.sessionManager.getCwd());
		};
		const pathCompletions: NonNullable<CommandPanelAction["getArgumentCompletions"]> = async (input, signal) => {
			const prefix =
				input.length > 1 && (input.startsWith("'") || input.startsWith('"')) && input.at(-1) === input[0]
					? input.slice(0, -1)
					: input;
			const quotedInput = prefix.startsWith("'")
				? `"${prefix.slice(1)}`
				: prefix.startsWith('"')
					? prefix
					: prefix.includes(" ")
						? `"${prefix}`
						: prefix;
			return this.completeCommandArguments(quotedInput, signal, true);
		};
		const command = (
			name: string,
			execute: (args: string) => void | Promise<void> | Promise<"edit" | undefined>,
			argumentMode: CommandPanelAction["argumentMode"] = "none",
			argumentHint?: string,
			getArgumentCompletions?: CommandPanelAction["getArgumentCompletions"],
		): CommandPanelAction => ({
			id: `local:${name}`,
			name,
			source: "Candy",
			argumentMode,
			argumentHint,
			getArgumentCompletions,
			execute: async (args) => {
				const result = await execute(args);
				return result === "edit" ? "edit" : undefined;
			},
		});
		return [
			command("New session", () => this.handleClearCommand()),
			command(
				"Export",
				(args) => this.handleExportCommand(resolveArgument(args)),
				"single",
				"Output path (.html or .jsonl)",
				pathCompletions,
			),
			command(
				"Import",
				(args) => this.handleImportCommand(resolveArgument(args) ?? ""),
				"single",
				"Session JSONL path",
				pathCompletions,
			),
		];
	}

	private getLocalCommandActions(): CommandPanelAction[] {
		return [
			{
				id: "local:debug",
				name: "debug",
				source: "Candy",
				argumentMode: "none",
				execute: async () => this.handleDebugCommand(),
			},
		];
	}

	private async showSkillConfiguration(): Promise<void> {
		const session = this.session;
		const generation = this.pageController.generation;
		const cwd = this.sessionManager.getCwd();
		const agentDir = this.runtimeHost.services.agentDir;
		const settingsManager = this.settingsManager;
		const {
			paths: { global, project },
			operations,
		} = await session.resources.getConfiguration();
		if (this.session !== session || this.pageController.generation !== generation) return;
		let changed = false;
		this.pageController.showSelector((done) => {
			const close = async () => {
				if (changed && (session.isStreaming || session.isCompacting)) {
					this.showWarning("Wait for the current response or compaction to finish before applying skills.");
					return;
				}
				done();
				if (changed) {
					await this.handleReloadCommand();
					this.presentation.resume();
				}
			};
			const selector = new ConfigSelectorComponent(
				{ global, project },
				settingsManager,
				cwd,
				agentDir,
				() => void close(),
				() => void close(),
				() => this.renderer.requestRender(),
				this.renderer.terminal.rows,
				"global",
				settingsManager.isProjectTrusted(),
				() => Math.floor(this.renderer.terminal.rows * 0.8),
				{
					resourceTypes: ["skills"],
					resourceConfiguration: operations,
					embedded: true,
					title: "Skills",
					beforeToggle: () =>
						session.isStreaming || session.isCompacting
							? "Wait for the current response or compaction to finish"
							: undefined,
					onOpen: (filePath) => {
						try {
							const reader = new ReadingPanelComponent(
								path.basename(path.dirname(filePath)),
								fs.readFileSync(filePath, "utf8"),
								() => {
									if (this.session === session) this.pageController.mountPanel(selector);
								},
							);
							this.pageController.mountPanel(reader);
						} catch (error) {
							this.showError(error instanceof Error ? error.message : String(error), "Could not read skill");
						}
					},
					onToggle: () => {
						changed = true;
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private setupAutocompleteProvider(): void {
		let provider = this.createBaseAutocompleteProvider();
		const triggerCharacters: string[] = [];
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
			triggerCharacters.push(...(provider.triggerCharacters ?? []));
		}
		if (triggerCharacters.length > 0) {
			provider.triggerCharacters = [...new Set(triggerCharacters)];
		}

		this.autocompleteProvider = provider;
		this.defaultEditor.setAutocompleteProvider(provider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(provider);
		}
	}

	private showStartupNoticesIfNeeded(): void {
		if (this.startupNoticesShown) return;
		this.startupNoticesShown = true;
		if (!this.changelogMarkdown) return;
		const title = `What's New · Installed v${this.version}`;
		const content = this.changelogMarkdown;
		this.chatContainer.addChild(
			new TranscriptNotice({ tone: "info", title, body: "", onOpen: () => this.showReader(title, content) }),
		);
		if (!this.settingsManager.getCollapseChangelog()) this.showReader(title, content);
	}

	private mountInteractiveTui(tui: TuiAltScreen, components: readonly Component[]): void {
		for (const component of components) tui.addChild(component);
		if (!this.fullscreenLayoutRoot) throw new Error("Fullscreen layout is not initialized");
		tui.setLayoutRoot(this.fullscreenLayoutRoot);
	}

	private stopInteractiveTui(fullscreenExitOutput: FullscreenExitOutput): void {
		const printTranscript = fullscreenExitOutput === "transcript";
		if (printTranscript) {
			while (this.renderer.hasOverlayEntries) this.renderer.hideOverlay();
			// Drop the viewport chrome so the plain transcript document is printed on exit.
			this.renderer.setLayoutRoot(undefined);
		}
		this.renderer.stop({ preserveScreen: !printTranscript });
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();

		// Load changelog (only show new entries, skip for resumed sessions)
		this.changelogMarkdown = await this.getChangelogForDisplay();

		// Keep one component tree and remount it when changing renderers.
		this.extensionWidgetAdapter.clear();
		const viewport = createChatViewport({
			header: this.topBar,
			document: this.documentContainer,
			pendingMessages: this.pendingMessagesContainer,
			status: this.statusContainer,
			widgetsAbove: this.extensionWidgetAdapter.above,
			editor: this.editorContainer,
			widgetsBelow: this.extensionWidgetAdapter.below,
			footer: this.footerContainer,
			scrollbar: this.settingsManager.getFullscreenScrollbar(),
			scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
		});
		this.transcriptScrollView = viewport.transcript;
		this.fullscreenLayoutRoot = viewport.root;
		this.mountInteractiveTui(this.renderer, [
			this.documentContainer,
			this.pendingMessagesContainer,
			this.statusContainer,
			this.extensionWidgetAdapter.above,
			this.editorContainer,
			this.extensionWidgetAdapter.below,
			this.footerContainer,
		]);
		// Accept text while startup completes, but only enable interrupt, exit, and submission feedback.
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onSubmit = (text, imagePaths, promptText) =>
			this.handleStartupSubmit(text, imagePaths, promptText);
		this.renderer.setFocus(this.editor);

		this.renderer.setSearchHost({
			mount: (component) => {
				this.transcriptSearch = component;
				this.pageController.mountPanel(component);
			},
			unmount: () => {
				this.transcriptSearch = undefined;
				this.pageController.closePanel();
			},
			isFocused: () =>
				this.transcriptSearch !== undefined &&
				this.composerPanel.isShowing(this.transcriptSearch) &&
				this.renderer.getFocusedComponent() === this.composerPanel,
		});

		// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
		this.renderer.start();
		this.isInitialized = true;

		await this.themeController.applyFromSettings();

		this.builtInHeader = new Text("", 0, 0);
		this.headerContainer.addChild(this.builtInHeader);
		this.renderer.requestRender();

		// Ensure fd and rg are available after mounting the TUI (downloads if missing, adds to PATH via getBinDir)
		// so slow downloads do not make startup appear frozen.
		// Both are needed: fd for autocomplete, rg for grep tool and bash commands.
		const [fdPath] = await Promise.all([
			ensureTool("fd", (status) => this.showManagedToolStatus(status)),
			ensureTool("rg", (status) => this.showManagedToolStatus(status)),
		]);
		this.fdPath = fdPath;

		// Enable the remaining input handlers only after managed-tool setup completes.
		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();
		this.renderer.requestRender();

		// Initialize extensions first so resources are shown before messages
		await this.rebindCurrentSession();

		// Render initial messages AFTER showing loaded resources
		this.renderInitialMessages();

		// Set up theme file watcher
		onThemeChange(() => {
			this.renderer.invalidate();
			this.updateEditorBorderColor();
			this.renderer.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.renderer.requestRender();
		});

		// Initialize available provider count for footer display
		await this.updateAvailableProviderCount();

		// Flush the completed startup state before loading the remaining syntax grammars.
		this.renderer.renderNow();
		void loadAllHighlightLanguages().then(() => {
			if (!this.isInitialized) return;
			this.renderer.invalidate();
			this.renderer.requestRender();
		});
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.renderer.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.renderer.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		await this.init();

		if (!process.env.CANDY_OFFLINE) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 15_000);
			void this.session.modelRuntime
				.refresh({ signal: controller.signal })
				.then(() => this.updateAvailableProviderCount())
				.catch(() => {})
				.finally(() => clearTimeout(timeout));
		}

		// Start package update check asynchronously
		this.checkForPackageUpdates()
			.then((updates) => {
				if (updates.length > 0) {
					this.showPackageUpdateNotification(updates);
				}
			})
			.finally(() => {
				// On Windows, npm can overwrite the shared console title while checking
				// extension package versions. Restore candy's title after the startup check.
				if (process.platform === "win32" && this.isInitialized) {
					this.updateTerminalTitle();
				}
			});

		// Check tmux keyboard setup asynchronously
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// Show startup warnings
		const {
			migratedProviders,
			startupDiagnostics,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages,
		} = this.options;

		for (const diagnostic of startupDiagnostics ?? []) {
			if (diagnostic.type === "error") {
				this.showError(diagnostic.message);
			} else if (diagnostic.type === "warning") {
				this.showWarning(diagnostic.message);
			} else {
				this.showStatus(diagnostic.message);
			}
		}

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRuntime.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		void this.maybeWarnAboutAnthropicSubscriptionAuth();

		// Process initial messages
		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		// Main interactive loop
		while (true) {
			const userInput = await this.getUserInput();
			try {
				await this.session.prompt(userInput.text, { images: userInput.images });
			} catch (error: unknown) {
				this.restoreInputToEditor(userInput);
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	private async checkForPackageUpdates(): Promise<string[]> {
		if (process.env.CANDY_OFFLINE) {
			return [];
		}

		try {
			const packageManager = new DefaultPackageManager({
				cwd: this.sessionManager.getCwd(),
				agentDir: getAgentDir(),
				settingsManager: this.settingsManager,
			});
			const updates = await packageManager.checkForAvailableUpdates();
			return updates.map((update) => update.displayName);
		} catch {
			return [];
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		if (extendedKeysFormat === "xterm") {
			return "tmux extended-keys-format is xterm. candy works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
		}

		return undefined;
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private async getChangelogForDisplay(): Promise<string | undefined> {
		// Skip changelog for resumed/continued sessions (already have messages)
		if (this.session.state.messages.length > 0) {
			return undefined;
		}

		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			// Fresh install - record the version and don't show changelog
			await this.settingsManager.commitSetting("global", "lastChangelogVersion", VERSION);
			return undefined;
		}

		const newEntries = getNewEntries(entries, lastVersion);
		if (newEntries.length > 0) {
			await this.settingsManager.commitSetting("global", "lastChangelogVersion", VERSION);
			return newEntries.map((e) => normalizeChangelogLinks(e.content, e)).join("\n\n");
		}

		return undefined;
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		const relativePath = path.relative(home, path.resolve(p));
		if (relativePath === "") return "~";
		if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return p;
		return path.join("~", relativePath);
	}

	private formatContextPath(p: string): string {
		const cwd = path.resolve(this.sessionManager.getCwd());
		const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
		const relativePath = getCwdRelativePath(absolutePath, cwd);
		if (relativePath !== undefined) {
			return relativePath;
		}

		return this.formatDisplayPath(absolutePath);
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
		const normalizedFullPath = fullPath.replace(/\\/g, "/");
		const baseDir = sourceInfo?.baseDir;
		if (baseDir && this.isPackageSource(sourceInfo)) {
			const normalizedBaseDir = baseDir.replace(/\\/g, "/");
			const npmRootMatch = normalizedBaseDir.match(/^(.*\/node_modules)\/(@?[^/]+(?:\/[^/]+)?)$/);
			// If fullPath is under the same node_modules root as baseDir, preserve that relative topology.
			if (npmRootMatch?.[1] && normalizedFullPath.startsWith(`${npmRootMatch[1]}/`)) {
				return path.posix.relative(normalizedBaseDir, normalizedFullPath);
			}

			const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
			if (
				relativePath &&
				relativePath !== "." &&
				!relativePath.startsWith("..") &&
				!relativePath.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relativePath)
			) {
				return relativePath.replace(/\\/g, "/");
			}
		}

		const source = sourceInfo?.source ?? "";
		const npmMatch = normalizedFullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		const gitMatch = normalizedFullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		return this.formatDisplayPath(fullPath);
	}

	private getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		const shortPath = this.getShortPath(resourcePath, sourceInfo);
		const normalizedPath = shortPath.replace(/\\/g, "/");
		const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
		if (segments.length > 0) {
			return segments[segments.length - 1]!;
		}
		return shortPath;
	}

	private getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
		const source = sourceInfo?.source ?? "";
		if (source.startsWith("npm:")) {
			return source.slice("npm:".length) || source;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			return gitSource.path || source;
		}

		return source;
	}

	private getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		if (!this.isPackageSource(sourceInfo)) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const sourceLabel = this.getCompactPackageSourceLabel(sourceInfo);
		if (!sourceLabel) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const shortPath = this.getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
		const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
		const parsedPath = path.posix.parse(packagePath);

		if (parsedPath.name === "index") {
			return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
		}

		return `${sourceLabel}:${packagePath}`;
	}

	private getCompactDisplayPathSegments(resourcePath: string): string[] {
		return this.formatDisplayPath(resourcePath)
			.replace(/\\/g, "/")
			.split("/")
			.filter((segment) => segment.length > 0 && segment !== "~");
	}

	private getCompactNonPackageExtensionLabel(
		resourcePath: string,
		index: number,
		allPaths: Array<{ path: string; segments: string[] }>,
	): string {
		const segments = allPaths[index]?.segments;
		if (!segments || segments.length === 0) {
			return this.getCompactPathLabel(resourcePath);
		}

		for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
			const candidate = segments.slice(-segmentCount).join("/");
			const isUnique = allPaths.every((item, itemIndex) => {
				if (itemIndex === index) {
					return true;
				}
				return item.segments.slice(-segmentCount).join("/") !== candidate;
			});

			if (isUnique) {
				return candidate;
			}
		}

		return segments.join("/");
	}

	private getCompactExtensionLabels(extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[] {
		const nonPackageExtensions = extensions
			.map((extension) => {
				const segments = this.getCompactDisplayPathSegments(extension.path);
				const lastSegment = segments[segments.length - 1];
				if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
					segments.pop();
				}
				return {
					path: extension.path,
					sourceInfo: extension.sourceInfo,
					segments,
				};
			})
			.filter((extension) => !this.isPackageSource(extension.sourceInfo));

		return extensions.map((extension) => {
			if (this.isPackageSource(extension.sourceInfo)) {
				return this.getCompactExtensionLabel(extension.path, extension.sourceInfo);
			}

			const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
			if (nonPackageIndex === -1) {
				return this.getCompactPathLabel(extension.path, extension.sourceInfo);
			}

			return this.getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
		});
	}

	private getDisplaySourceInfo(sourceInfo?: SourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private isPackageSource(sourceInfo?: SourceInfo): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
		const exact = sourceInfos.get(p);
		if (exact) return exact;

		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	private formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(p, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	private formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			lines.push(
				theme.fg(
					"dim",
					`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
						),
					);
				}
			}
		}

		for (const d of otherDiagnostics) {
			if (d.path) {
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		// Resource rendering is idempotent; chat clears no longer clear this separate container.
		this.loadedResourcesContainer.clear();

		this.splashComponent?.setResources(this.getHomeResources());
		const showListing = options?.force || this.options.verbose;
		const showDiagnostics =
			showListing || !this.settingsManager.getQuietStartup() || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();
		const extensions =
			options?.extensions ??
			this.session.resourceLoader
				.getExtensions()
				.extensions.filter((extension) => !extension.hidden)
				.map((extension) => ({
					path: extension.path,
					sourceInfo: extension.sourceInfo,
				}));
		const sourceInfos = new Map<string, SourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skillsResult.skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of promptsResult.prompts) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of themesResult.themes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing) {
			const systemPromptSource = this.session.resourceLoader.getSystemPromptSource();
			const contextFiles = [
				...(systemPromptSource ? [systemPromptSource] : []),
				...this.session.resourceLoader.getAppendSystemPromptSources(),
				...this.session.resourceLoader.getAgentsFiles().agentsFiles,
			];
			const extensionLabels = this.getCompactExtensionLabels(extensions);
			const sections: LoadedResourceSection[] = [
				{
					name: "Context",
					entries: contextFiles.map((file) => ({ name: this.formatContextPath(file.path), path: file.path })),
				},
				{
					name: "Skills",
					entries: skillsResult.skills.map((skill) => ({
						name: skill.name,
						path: skill.filePath,
						source: skill.sourceInfo?.source,
					})),
				},
				{
					name: "Prompts",
					entries: this.session.promptTemplates.map((prompt) => ({
						name: prompt.name,
						path: prompt.filePath,
						source: prompt.sourceInfo?.source,
					})),
				},
				{
					name: "Extensions",
					entries: extensions.map((extension, index) => ({
						name: extensionLabels[index],
						path: extension.path,
						source: extension.sourceInfo?.source,
					})),
				},
				{
					name: "Themes",
					entries: themesResult.themes
						.filter((loadedTheme) => loadedTheme.sourcePath)
						.map((loadedTheme) => ({
							name:
								loadedTheme.name ?? this.getCompactPathLabel(loadedTheme.sourcePath!, loadedTheme.sourceInfo),
							path: loadedTheme.sourcePath!,
							source: loadedTheme.sourceInfo?.source,
						})),
				},
			].filter((section) => section.entries.length > 0);
			if (sections.length) this.loadedResourcesContainer.addChild(new LoadedResourcesComponent(sections, true));
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(skillDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new TranscriptNotice({ tone: "warning", title: "Skill conflicts", body: warningLines }),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new TranscriptNotice({ tone: "warning", title: "Prompt conflicts", body: warningLines }),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionsResult = this.session.resourceLoader.getExtensions();
			for (const error of extensionsResult.errors) {
				extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
			}
			for (const warning of extensionsResult.warnings ?? []) {
				extensionDiagnostics.push({ type: "warning", message: warning.warning, path: warning.path });
			}

			const commandDiagnostics = this.session.extensionRunner.getCommandDiagnostics();
			extensionDiagnostics.push(...commandDiagnostics);

			const shortcutDiagnostics = this.session.extensionRunner.getShortcutDiagnostics();
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new TranscriptNotice({ tone: "warning", title: "Extension issues", body: warningLines }),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new TranscriptNotice({ tone: "warning", title: "Theme conflicts", body: warningLines }),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async bindCurrentSessionExtensions(): Promise<void> {
		const uiContext = this.createExtensionUIContext();
		const sessionActions = createSessionCommandActions(this.runtimeHost);
		await this.session.bindExtensions({
			uiContext,
			mode: "tui",
			abortHandler: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			commandContextActions: {
				...sessionActions,
				newSession: async (options) => {
					this.clearStatusIndicator();
					try {
						return await sessionActions.newSession(options);
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to create session", error);
					}
				},
				fork: async (entryId, options) => {
					try {
						const result = await sessionActions.fork(entryId, options);
						if (!result.cancelled) {
							this.editor.setText(result.selectedText ?? "");
							this.showStatus("Forked to new session");
						}
						return { cancelled: result.cancelled };
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				navigateTree: async (targetId, options) => {
					const result = await sessionActions.navigateTree(targetId, options);
					if (result.cancelled) {
						return { cancelled: true };
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");
					return { cancelled: false };
				},
				switchSession: async (sessionPath, options) => {
					try {
						return await sessionActions.switchSession(sessionPath, options);
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to switch session", error);
					}
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (this.session.isIdle) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocompleteProvider();

		const extensionRunner = this.session.extensionRunner;
		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
		this.showStartupNoticesIfNeeded();
	}

	private applyFullscreenScrollbarSetting(): void {
		this.transcriptScrollView?.setScrollbar(this.settingsManager.getFullscreenScrollbar());
	}

	private applyRuntimeSettings(): void {
		setCapabilityOverrides(this.settingsManager.getTerminalCapabilityOverrides());
		this.applyFullscreenScrollbarSetting();
		this.renderer.setCopyOnSelect(this.settingsManager.getFullscreenCopyOnSelect());
		this.footer.setSession(this.session);
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.outputPad = this.settingsManager.getOutputPad();
		this.renderer.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		const clearOnShrink = this.settingsManager.getClearOnShrink();
		this.renderer.setClearOnShrink(clearOnShrink);
		if (!clearOnShrink && !this.activeStatusIndicator) {
			this.statusContainer.clear();
			this.statusContainer.addChild(this.notification);
		}
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	private async rebindCurrentSession(options: { renderBeforeBind?: boolean } = {}): Promise<void> {
		const session = this.session;
		this.cancelActiveLogin();
		if (this.presentation.active) this.presentation.finish();
		if (this.inputMode === "help") this.exitHelpMode();
		else this.setInputMode("normal");

		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.applyRuntimeSettings();

		if (options.renderBeforeBind) {
			this.renderCurrentSessionState();
			this.subscribeToAgent();
		}

		await this.bindCurrentSessionExtensions();

		if (this.session !== session) {
			return;
		}

		if (!options.renderBeforeBind) {
			this.subscribeToAgent();
		}

		await this.updateAvailableProviderCount();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
		this.defaultEditor.restartEntranceAnimation();
	}

	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		const extensionHint = this.getCrashExtensionHint(error);
		if (extensionHint) {
			this.chatContainer.addChild(new Text(theme.fg("warning", extensionHint), this.outputPad, 0));
		}
		stopThemeWatcher();
		this.stop("transcript");
		process.exit(1);
	}

	private getCrashExtensionHint(error: unknown): string | undefined {
		try {
			return formatCrashExtensionHint(
				findExtensionStackMatches(
					error instanceof Error ? error.stack : undefined,
					this.session.resourceLoader.getExtensions().extensions,
				),
			);
		} catch {
			return undefined;
		}
	}

	private renderCurrentSessionState(): void {
		this.loadedResourcesContainer.clear();
		this.chatContainer.clear();
		this.splashComponent = undefined;
		this.notification.clear();
		this.pendingMessagesContainer.clear();
		this.sessionPresentation.endStreaming();
		this.pendingTools.clear();
		this.renderInitialMessages();
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	/**
	 * Extension-registered definition, falling back to the built-in one. The renderer components take
	 * whatever this returns, so they never reach into the tool registry themselves.
	 */
	private getRegisteredToolDefinition(toolName: string) {
		return withBuiltInRenderers(toolName, this.session.getToolDefinition(toolName));
	}

	private getMarkdownTransformers(): MarkdownTransformer[] {
		return this.session.extensionRunner.getMarkdownTransformers();
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					void Promise.resolve()
						.then(() => shortcut.handler(extensionRunner.createContext()))
						.catch((err) => {
							this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
						});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.renderer.requestRender();
	}

	private setEditorWorkingStatusIndicator(indicator: StatusIndicator | undefined): boolean {
		this.defaultEditor.setWorkingStatusIndicator(undefined);
		if (!isWorkingStatusEditor(this.editor)) return false;
		this.editor.setWorkingStatusIndicator(indicator);
		return true;
	}

	private showStatusIndicator(indicator: StatusIndicator): void {
		this.activeStatusIndicator?.dispose();
		this.activeStatusIndicator = indicator;
		this.activeWorkingIndicatorEmbedded = false;
		this.statusContainer.clear();
		this.statusContainer.addChild(this.notification);
		this.setEditorWorkingStatusIndicator(undefined);
		if (this.setEditorWorkingStatusIndicator(indicator)) {
			this.activeWorkingIndicatorEmbedded = true;
			return;
		}
		this.statusContainer.addChild(indicator);
	}

	private clearStatusIndicator(kind?: StatusIndicator["kind"]): void {
		if (kind && this.activeStatusIndicator?.kind !== kind) {
			return;
		}
		const clearedIndicator = this.activeStatusIndicator;
		clearedIndicator?.dispose();
		this.activeStatusIndicator = undefined;
		this.activeWorkingIndicatorEmbedded = false;
		this.statusContainer.clear();
		this.statusContainer.addChild(this.notification);
		this.setEditorWorkingStatusIndicator(undefined);
	}

	private showWorkingStatusIndicator(): void {
		const colorFn = isWorkingStatusEditor(this.editor)
			? (text: string) =>
					(this.editor.borderColor ?? theme.getThinkingBorderColor(this.session.thinkingLevel || "off"))(text)
			: undefined;
		this.showStatusIndicator(new WorkingStatusIndicator(this.renderer, this.defaultWorkingMessage, colorFn));
	}

	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		if (!visible) {
			this.clearStatusIndicator("working");
			this.renderer.requestRender();
			return;
		}
		if (this.session.isStreaming && this.activeStatusIndicator?.kind !== "working") {
			this.showWorkingStatusIndicator();
		}
		this.renderer.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		if (this.sessionPresentation.streamingComponent) {
			this.sessionPresentation.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.renderer.requestRender();
	}

	private resetExtensionUI(): void {
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.renderer.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.extensionWidgetAdapter.clear();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.autocompleteProviderWrappers = [];
		this.setCustomEditorComponent(undefined);
		this.setupAutocompleteProvider();
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		this.workingVisible = true;
		if (this.activeStatusIndicator?.kind === "working") {
			this.activeStatusIndicator.setMessage(
				`${this.defaultWorkingMessage} (${keyHint("app.interrupt", "to interrupt")})`,
			);
		}
		this.setHiddenThinkingLabel();
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		this.footerContainer.clear();
		if (factory) {
			// Create and add custom footer, passing the data provider
			this.customFooter = factory(this.renderer, theme, this.footerDataProvider);
			this.footerContainer.addChild(this.customFooter);
		} else {
			// The built-in status lives in the editor's bottom border.
			this.customFooter = undefined;
		}

		this.renderer.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.renderer, theme);
			if (isExpandable(this.customHeader)) {
				this.customHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (isExpandable(this.builtInHeader)) {
				this.builtInHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.renderer.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const subscription = { handler, unsubscribe: this.renderer.addInputListener(handler) };
		this.extensionTerminalInputSubscriptions.add(subscription);
		return () => {
			subscription.unsubscribe();
			this.extensionTerminalInputSubscriptions.delete(subscription);
		};
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const subscription of this.extensionTerminalInputSubscriptions) subscription.unsubscribe();
		this.extensionTerminalInputSubscriptions.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createProjectTrustContext(cwd: string): ProjectTrustContext {
		const ui = this.createExtensionUIContext();
		return {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: {
				select: ui.select,
				confirm: ui.confirm,
				input: ui.input,
				notify: ui.notify,
			},
			selectTrust: (trustCwd) =>
				this.promptProjectTrust(
					trustCwd,
					new ProjectTrustStore(this.runtimeHost.services.agentDir).getEntry(trustCwd),
					false,
				),
		};
	}

	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.extensionWidgetAdapter.set(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.renderer.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: async (themeOrName) => {
				if (typeof themeOrName !== "string") return this.themeController.setThemeInstance(themeOrName);
				const result = this.themeController.setThemeName(themeOrName);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						await this.settingsManager.commitSetting("global", "theme", themeOrName);
					}
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Mount a transient panel and resolve when its callbacks complete it. `open`
	 * creates the component (storing it for later disposal), wires `done` into its
	 * select/cancel callbacks, and returns the panel with its close routine.
	 */
	private panelDialog<T>(
		opts: ExtensionUIDialogOptions | undefined,
		open: (done: (value: T | undefined) => void) => {
			component: Parameters<InteractivePageController["mountPanel"]>[0];
			close: () => void;
		},
	): Promise<T | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}
			let settled = false;
			let close: () => void;
			const onAbort = () => {
				if (settled) return;
				settled = true;
				close();
				resolve(undefined);
			};
			const finish = (value: T | undefined) => {
				if (settled) return;
				settled = true;
				opts?.signal?.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const { component, close: closePanel } = open(finish);
			close = closePanel;
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			this.pageController.disposeActiveSelector();
			this.pageController.mountPanel(component);
		});
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
		horizontal = false,
	): Promise<string | undefined> {
		return this.panelDialog<string>(opts, (done) => {
			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					this.hideExtensionSelector();
					done(option);
				},
				() => {
					this.hideExtensionSelector();
					done(undefined);
				},
				{
					tui: this.renderer,
					timeout: opts?.timeout,
					horizontal,
					onToggleToolsExpanded: () => this.toggleToolOutputExpansion(),
				},
			);
			return { component: this.extensionSelector, close: () => this.hideExtensionSelector() };
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.extensionSelector = undefined;
		this.pageController.closePanel();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts, true);
		return result === "Yes";
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.panelDialog<string>(opts, (done) => {
			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					this.hideExtensionInput();
					done(value);
				},
				() => {
					this.hideExtensionInput();
					done(undefined);
				},
				{ tui: this.renderer, timeout: opts?.timeout },
			);
			return { component: this.extensionInput, close: () => this.hideExtensionInput() };
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.extensionInput = undefined;
		this.pageController.closePanel();
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(
		title: string,
		prefill?: string,
		validate?: () => string | undefined,
	): Promise<string | undefined> {
		return this.panelDialog<string>(undefined, (done) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.renderer,
				this.keybindings,
				title,
				prefill,
				(value) => {
					const reason = validate?.();
					if (reason) {
						this.showWarning(reason);
						return;
					}
					this.hideExtensionEditor();
					done(value);
				},
				() => {
					this.hideExtensionEditor();
					done(undefined);
				},
				undefined,
				this.settingsManager.getExternalEditorCommand(),
			);
			return { component: this.extensionEditor, close: () => this.hideExtensionEditor() };
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.extensionEditor = undefined;
		this.pageController.closePanel();
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		if (!factory && this.editor === this.defaultEditor) return;
		if (this.inputMode === "help") this.exitHelpMode();
		else if (factory) this.setInputMode("normal");
		this.editorComponentFactory = factory;

		// Save text from current editor before switching
		const currentText = this.editor.getText();

		this.pageController.disposeActiveSelector();
		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.renderer, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}
			if (newEditor.setAutocompleteMaxVisible !== undefined) {
				newEditor.setAutocompleteMaxVisible(this.defaultEditor.getAutocompleteMaxVisible());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				if (typeof customEditor.setBottomStatus === "function") {
					(customEditor.setBottomStatus as (status: EditorBottomStatus | undefined) => void).call(
						customEditor,
						this.footer,
					);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		if (this.activeStatusIndicator) {
			this.statusContainer.clear();
			this.statusContainer.addChild(this.notification);
			this.activeWorkingIndicatorEmbedded = this.setEditorWorkingStatusIndicator(this.activeStatusIndicator);
			if (!this.activeWorkingIndicatorEmbedded) {
				this.statusContainer.addChild(this.activeStatusIndicator);
			}
		}
		this.renderer.setFocus(this.editor as Component);
		this.renderer.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const isOverlay = options?.overlay ?? false;
		const previousFocus = this.renderer.getFocusedComponent();

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.renderer.setFocus(previousFocus ?? this.editor);
			this.renderer.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: (Component & { dispose?(): void }) | undefined;
			let closed = false;
			let settled = false;
			const disposeComponent = (value: Component & { dispose?(): void }): void => {
				try {
					value.dispose?.();
				} catch (error: unknown) {
					this.showExtensionError("custom UI", error instanceof Error ? error.message : String(error));
				}
			};

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.renderer.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				if (component) disposeComponent(component);
				settled = true;
				resolve(result);
			};

			Promise.resolve(factory(this.renderer, theme, this.keybindings, close))
				.then((c) => {
					if (closed) {
						disposeComponent(c);
						return;
					}
					component = c;
					if (isOverlay) {
						const overlayOptions =
							typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
						const handle = this.renderer.showOverlay(component, overlayOptions);
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.pageController.disposeActiveSelector();
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.renderer.setFocus(component);
						this.renderer.requestRender();
					}
				})
				.catch((err) => {
					if (closed || settled) {
						this.showExtensionError("custom UI", err instanceof Error ? err.message : String(err));
						return;
					}
					if (!isOverlay) restoreEditor();
					settled = true;
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.renderer.requestRender();
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			if (this.session.isBashRunning) {
				this.session.abortBash();
			} else if (this.inputMode === "help") {
				this.exitHelpMode();
			} else if (this.inputMode !== "normal") {
				this.setInputMode(this.inputMode === "shell-no-context" ? "shell" : "normal");
			} else if (this.session.isStreaming) {
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (!this.editor.getText().trim()) {
				// Double Escape opens the configured History view.
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						this.openPresentation("history");
						if (action === "tree") {
							this.showTreeSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());

		// Global debug handler on TUI (works regardless of focus)
		this.renderer.onDebug = () => this.handleDebugCommand();
		this.defaultEditor.onAction("app.model.select", () => this.footer.openPowerbarModelBrowse());
		this.defaultEditor.powerbarHandler = (data) => this.handlePowerbarKey(data);
		this.defaultEditor.modeInputHandler = (data) => this.handleModeInput(data);
		this.defaultEditor.onBottomBorderClick = (x) => this.footer.handleBottomBorderClick(x);
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.editor.external", () => void this.handleOpenExternalEditor());
		this.defaultEditor.onAction("app.reload", () => void this.handleReloadCommand());
		this.defaultEditor.onAction(
			"app.message.copy",
			() => void this.handleCopyCommand({ flashConfirmation: true, preferSelection: true }),
		);
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
		this.defaultEditor.onAction("app.session.tree", () => {
			this.openPresentation("history");
			this.showTreeSelector();
		});
		this.defaultEditor.onAction("app.session.fork", () => {
			this.openPresentation("history");
			this.showUserMessageSelector();
		});
		this.defaultEditor.onAction("app.session.resume", () => {
			this.openPresentation("history");
			this.showSessionSelector();
		});

		// Handle clipboard paste (triggered on Ctrl+V). Images are attached by path;
		// otherwise, paste plain text from the system clipboard.
		this.defaultEditor.onPasteImage = () => {
			void this.handleClipboardPaste();
		};
		this.defaultEditor.onImagePath = (filePath) => this.showStatus(filePath);
	}

	private setInputMode(mode: InputMode): void {
		if (this.inputMode === mode) return;
		this.inputMode = mode;
		this.defaultEditor.setHistoryScope(mode === "normal" ? "default" : mode);
		this.defaultEditor.setInputMode(mode);
		this.updateEditorBorderColor();
	}

	private enterHelpMode(): void {
		this.setInputMode("help");
		this.defaultEditor.setAutocompleteProvider(undefined);
		if (!this.helpPanel) {
			this.helpPanel = new HelpPanel(
				this.renderer,
				() => this.defaultEditor.getText(),
				(id) => {
					if (id === "hotkeys") this.handleHotkeysCommand();
					else this.handleChangelogCommand();
				},
			);
			this.helpPanel.setOptions(
				this.settingsManager.getUiAnimations(),
				this.settingsManager.getAnimationIntensity(),
			);
		}
		this.editorContainer.clear();
		this.editorContainer.addChild(this.helpPanel);
		this.editorContainer.addChild(this.defaultEditor);
		this.renderer.setFocus(this.defaultEditor);
		this.helpPanel.open();
		this.renderer.requestRender();
	}

	private exitHelpMode(): void {
		this.setInputMode("normal");
		this.defaultEditor.setText("");
		this.defaultEditor.setAutocompleteProvider(this.autocompleteProvider);
		const panel = this.helpPanel!;
		panel.close(() => {
			if (this.helpPanel !== panel) return;
			this.editorContainer.removeChild(panel);
			this.helpPanel = undefined;
			panel.dispose();
			this.renderer.requestRender();
		});
	}

	private handleModeInput(data: string): boolean {
		if (this.editor !== this.defaultEditor) return false;
		if (this.inputMode === "help") {
			if (this.keybindings.matches(data, "tui.input.newLine")) return true;
			if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down")) {
				this.helpPanel!.move(data);
				return true;
			}
			if (this.keybindings.matches(data, "tui.input.submit")) {
				this.helpPanel!.select();
				return true;
			}
			if (
				this.keybindings.matches(data, "app.interrupt") ||
				this.keybindings.matches(data, "app.clear") ||
				(this.editor.getText().length === 0 && this.keybindings.matches(data, "tui.editor.deleteCharBackward"))
			) {
				this.exitHelpMode();
				return true;
			}
			if (this.keybindings.matches(data, "app.reload")) this.exitHelpMode();
			return false;
		}
		if (this.editor.getText().length !== 0) return false;
		if (this.inputMode === "normal" && this.keybindings.matches(data, "app.command.enter")) {
			this.openPresentation("command");
			return true;
		}
		if (this.inputMode === "normal" && this.keybindings.matches(data, "app.help.enter")) {
			this.enterHelpMode();
			return true;
		}
		if (
			this.keybindings.matches(data, "app.shell.enter") &&
			(this.inputMode === "normal" || this.inputMode === "shell")
		) {
			this.setInputMode(this.inputMode === "normal" ? "shell" : "shell-no-context");
			return true;
		}
		if (this.keybindings.matches(data, "tui.editor.deleteCharBackward") && this.inputMode !== "normal") {
			this.setInputMode(this.inputMode === "shell-no-context" ? "shell" : "normal");
			return true;
		}
		return false;
	}

	private async handleRightClickPaste(): Promise<void> {
		const target = this.renderer.getFocusedComponent();
		const handleInput = target?.handleInput;
		if (!target || !handleInput) return;
		try {
			const text = await readClipboardText();
			if (!text || this.renderer.getFocusedComponent() !== target) return;
			handleInput.call(target, `\x1b[200~${text}\x1b[201~`);
			this.renderer.requestRender();
		} catch {
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	private async handleClipboardPaste(): Promise<void> {
		try {
			const image = await readClipboardImage();
			if (image) {
				const tmpDir = os.tmpdir();
				const ext = extensionForImageMimeType(image.mimeType) ?? "png";
				const fileName = `candy-clipboard-${crypto.randomUUID()}.${ext}`;
				const filePath = path.join(tmpDir, fileName);
				fs.writeFileSync(filePath, Buffer.from(image.bytes));

				const dimensions = getImageDimensions(Buffer.from(image.bytes).toString("base64"), image.mimeType);
				if (this.editor === this.defaultEditor && dimensions) {
					this.defaultEditor.insertImageAtCursor(filePath, {
						width: dimensions.widthPx,
						height: dimensions.heightPx,
					});
				} else {
					this.editor.insertTextAtCursor?.(filePath);
				}
				this.renderer.requestRender();
				return;
			}

			const text = await readClipboardText();
			if (text) {
				this.editor.insertTextAtCursor?.(text);
				this.renderer.requestRender();
			}
		} catch {
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	private handleStartupSubmit(text: string, imagePaths?: string[], promptText?: string): void {
		const input = this.createEditorInput(text, imagePaths, promptText);
		this.editor.setText(omitImageMarkers(input.text));
		this.restoreImagesToEditor(input.images ?? []);
		this.showStatus("Startup is still in progress");
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string, imagePaths?: string[], promptText?: string) => {
			text = text.trim();
			if (!text) return;
			if (this.inputMode === "help") return;

			if (this.inputMode === "shell" || this.inputMode === "shell-no-context") {
				if (this.session.isBashRunning) {
					this.showWarning("A bash command is already running. Press Esc to cancel it first.");
					this.editor.setText(text);
					return;
				}
				this.editor.addToHistory?.(text);
				await this.handleBashCommand(text, this.inputMode === "shell-no-context");
				return;
			}

			let input: QueuedInput;
			try {
				input = this.createEditorInput(text, imagePaths, promptText);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
				return;
			}
			if (!this.session.model) {
				this.editor.setText(omitImageMarkers(input.text));
				this.restoreImagesToEditor(input.images ?? []);
				this.showError("Select a model in Sources", "No model selected");
				return;
			}

			if (this.session.isCompacting) {
				this.queueCompactionMessage(input, "steer");
				return;
			}

			// If streaming, use prompt() with steer behavior
			if (this.session.isStreaming) {
				this.editor.addToHistory?.(input.text);
				this.editor.setText("");
				try {
					await this.session.prompt(input.text, { images: input.images, streamingBehavior: "steer" });
				} catch (error) {
					this.restoreInputToEditor(input);
					this.showError(`Failed to queue message: ${error instanceof Error ? error.message : String(error)}`);
				}
				this.updatePendingMessagesDisplay();
				this.renderer.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.flushPendingBashComponents();

			if (this.onInputCallback) {
				this.onInputCallback(input);
			} else {
				this.pendingUserInputs.push(input);
			}
			this.editor.addToHistory?.(input.text);
		};
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
	}

	/**
	 * Repaint when the context line's rounded percentage changes.
	 */
	private refreshContextLine(): void {
		const percent = this.session.getContextUsage()?.percent ?? null;
		const rounded =
			percent === null || !Number.isFinite(percent) ? null : Math.round(Math.max(0, Math.min(100, percent)));
		if (rounded === this.lastContextPercent) return;
		this.lastContextPercent = rounded;
		this.renderer.requestRender();
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		this.footer.invalidate();
		// Delta events fire per token; context usage cannot change between them.
		if (
			event.type !== "message_update" &&
			event.type !== "tool_execution_update" &&
			event.type !== "bash_execution_update"
		) {
			this.refreshContextLine();
		}

		switch (event.type) {
			case "agent_start":
				this.pendingTools.clear();
				// Restore main escape handler if retry handler is still active
				// (retry success event fires later, but we need main handler now)
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				break;

			case "turn_start":
				if (this.settingsManager.getShowTerminalProgress()) {
					this.renderer.terminal.setProgress(true);
				}
				if (this.workingVisible) {
					if (this.activeStatusIndicator?.kind !== "working") {
						this.showWorkingStatusIndicator();
					}
				} else {
					this.clearStatusIndicator();
				}
				this.renderer.requestRender();
				break;

			case "queue_update":
				this.updatePendingMessagesDisplay();
				this.renderer.requestRender();
				break;

			case "entry_appended":
				if (this.sessionPresentation.consumeBoundaryCompactionEntry(event.entry.id)) break;
				if (event.entry.type === "custom") {
					this.addCustomEntryToChat(event.entry);
					this.renderer.requestRender();
				} else if (event.entry.type === "usage" && event.entry.kind === "cache_warm") {
					this.addCacheWarmingUsage(event.entry);
					this.renderer.requestRender();
				} else if (event.entry.type === "custom_message" && event.entry.display) {
					this.addMessageToChat(
						createCustomMessage(
							event.entry.customType,
							event.entry.content,
							event.entry.display,
							event.entry.details,
							event.entry.timestamp,
						),
					);
					this.renderer.requestRender();
				} else if (event.entry.type === "compaction") {
					const entries = this.sessionManager.buildContextEntries();
					if (entries[0]?.id !== event.entry.id) break;
					this.chatContainer.clear();
					const branch = this.sessionManager.getBranch();
					const compactionIndex = branch.findIndex((entry) => entry.id === event.entry.id);
					const entriesAfterCompaction = new Set(branch.slice(compactionIndex + 1).map((entry) => entry.id));
					const retainedEntries = entries.slice(1);
					this.renderSessionEntries(retainedEntries.filter((entry) => !entriesAfterCompaction.has(entry.id)));
					this.addMessageToChat(
						createCompactionSummaryMessage(event.entry.summary, event.entry.tokensBefore, event.entry.timestamp),
					);
					if (event.entry.usage) {
						this.addCompactionCostNotice({
							type: "compaction_cost",
							kind: "compaction",
							usage: event.entry.usage,
						});
					}
					this.renderSessionEntries(retainedEntries.filter((entry) => entriesAfterCompaction.has(entry.id)));
					this.sessionPresentation.markEntriesRenderedByBoundaryCompaction(entriesAfterCompaction);
					this.footer.invalidate();
					this.renderer.requestRender();
				}
				break;

			case "session_info_changed":
				this.updateTerminalTitle();
				this.footer.invalidate();
				this.renderer.requestRender();
				break;

			case "thinking_level_changed":
				this.footer.invalidate();
				this.updateEditorBorderColor();
				break;

			case "message_start":
				if (event.message.role === "custom") {
					this.addMessageToChat(event.message);
					this.renderer.requestRender();
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.renderer.requestRender();
				} else if (event.message.role === "assistant") {
					const component = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
						this.hiddenThinkingLabel,
						this.outputPad,
						this.getMarkdownTransformers(),
						this.mermaidCodeBlockView,
					);
					component.setAnimationOptions(
						this.settingsManager.getUiAnimations(),
						this.settingsManager.getAnimationIntensity(),
						() => this.renderer.requestRender(),
					);
					this.sessionPresentation.beginStreaming(component, event.message);
					this.chatContainer.addChild(component);
					component.updateContent(event.message, true);
					this.renderer.requestRender();
				}
				break;

			case "message_update": {
				const updateComponent = this.sessionPresentation.streamingComponent;
				if (updateComponent && event.message.role === "assistant") {
					this.sessionPresentation.updateStreaming(event.message);
					updateComponent.updateContent(event.message, true, event.assistantMessageEvent);

					for (const content of event.message.content) {
						if (content.type === "toolCall") {
							if (!this.pendingTools.has(content.id)) {
								const component = new ToolExecutionComponent(
									content.name,
									content.id,
									content.arguments,
									{
										showImages: this.settingsManager.getShowImages(),
										imageWidthCells: this.settingsManager.getImageWidthCells(),
										toolPreviewLines: this.settingsManager.getToolPreviewLines(),
									},
									this.getRegisteredToolDefinition(content.name),
									this.renderer,
									this.sessionManager.getCwd(),
								);
								component.setExpanded(this.toolOutputExpanded);
								this.addToolToChat(component);
								this.pendingTools.set(content.id, component);
							} else {
								const component = this.pendingTools.get(content.id);
								if (component) {
									component.updateArgs(content.arguments);
								}
							}
						}
					}
					this.renderer.requestRender();
				}
				break;
			}

			case "message_end": {
				if (event.message.role === "user") break;
				const endComponent = this.sessionPresentation.streamingComponent;
				if (endComponent && event.message.role === "assistant") {
					this.sessionPresentation.updateStreaming(event.message);
					let errorMessage: string | undefined;
					if (event.message.stopReason === "aborted") {
						const retryAttempt = this.session.retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						event.message.errorMessage = errorMessage;
					}
					endComponent.updateContent(event.message, false);

					if (event.message.stopReason === "aborted" || event.message.stopReason === "error") {
						if (!errorMessage) {
							errorMessage = event.message.errorMessage || "Error";
						}
						for (const [, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
							if (event.message.stopReason === "aborted") component.markCancelled();
						}
						this.pendingTools.clear();
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
						this.maybeShowThinkingDropNotice(event.message);
						this.maybeShowCacheMissNotice(event.message);
					}
					this.sessionPresentation.endStreaming();
					this.footer.invalidate();
				}
				this.renderer.requestRender();
				break;
			}

			case "bash_execution_update":
				// The bash execution callback handles TUI output rendering.
				break;

			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{
							showImages: this.settingsManager.getShowImages(),
							imageWidthCells: this.settingsManager.getImageWidthCells(),
							toolPreviewLines: this.settingsManager.getToolPreviewLines(),
						},
						this.getRegisteredToolDefinition(event.toolName),
						this.renderer,
						this.sessionManager.getCwd(),
					);
					component.setExpanded(this.toolOutputExpanded);
					this.addToolToChat(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				this.renderer.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.renderer.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					if (event.cancelled) component.markCancelled();
					this.pendingTools.delete(event.toolCallId);
					this.renderer.requestRender();
				}
				break;
			}

			case "agent_end":
				if (this.settingsManager.getShowTerminalProgress()) {
					this.renderer.terminal.setProgress(false);
				}
				this.clearStatusIndicator("working");
				if (this.sessionPresentation.streamingComponent) {
					this.chatContainer.removeChild(this.sessionPresentation.streamingComponent);
					this.sessionPresentation.endStreaming();
				}
				this.pendingTools.clear();

				this.renderer.requestRender();
				break;

			case "agent_settled":
				await this.checkShutdownRequested();
				break;

			case "compaction_start": {
				if (this.settingsManager.getShowTerminalProgress()) {
					this.renderer.terminal.setProgress(true);
				}
				// Keep editor active; submissions are queued during compaction.
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortCompaction();
				};
				this.showStatusIndicator(new CompactionStatusIndicator(this.renderer, event.reason));
				this.renderer.requestRender();
				break;
			}

			case "compaction_end": {
				if (this.settingsManager.getShowTerminalProgress()) {
					this.renderer.terminal.setProgress(false);
				}
				if (this.autoCompactionEscapeHandler) {
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				this.clearStatusIndicator("compaction");
				if (event.aborted) {
					if (event.reason === "manual") {
						this.showStatus("Compaction cancelled");
					} else {
						this.showStatus("Auto-compaction cancelled");
					}
				} else if (event.result) {
					const entries = this.sessionManager.buildContextEntries();
					if (entries[0]?.type !== "compaction") {
						throw new Error("Completed compaction is missing from the session context");
					}
					this.chatContainer.clear();
					// The latest compaction is prepended for model context; append it below at its chronological position.
					this.renderSessionEntries(entries.slice(1));
					this.addMessageToChat(
						createCompactionSummaryMessage(
							event.result.summary,
							event.result.tokensBefore,
							new Date().toISOString(),
						),
					);
					if (event.result.usage) {
						this.addCompactionCostNotice({
							type: "compaction_cost",
							kind: "compaction",
							usage: event.result.usage,
						});
					}
					this.footer.invalidate();
				} else if (event.errorMessage) {
					if (event.reason === "manual") {
						this.showError(event.errorMessage);
					} else {
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
					}
				}
				this.renderer.requestRender();
				break;
			}

			case "auto_retry_start": {
				// Set up escape to abort retry
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortRetry();
				};
				this.showStatusIndicator(
					new RetryStatusIndicator(this.renderer, event.attempt, event.maxAttempts, event.delayMs),
				);
				this.renderer.requestRender();
				break;
			}

			case "auto_retry_end": {
				// Restore escape handler
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				this.clearStatusIndicator("retry");
				// Show error only on final failure (success shows normal response)
				if (!event.success) {
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				this.renderer.requestRender();
				break;
			}

			case "summarization_retry_scheduled": {
				this.showError(event.errorMessage);
				this.showStatusIndicator(
					new RetryStatusIndicator(this.renderer, event.attempt, event.maxAttempts, event.delayMs),
				);
				this.renderer.requestRender();
				break;
			}

			case "summarization_retry_attempt_start": {
				this.clearStatusIndicator("retry");
				if (event.source === "branchSummary") {
					this.showStatusIndicator(new BranchSummaryStatusIndicator(this.renderer));
				} else {
					this.showStatusIndicator(new CompactionStatusIndicator(this.renderer, event.reason));
				}
				this.renderer.requestRender();
				break;
			}

			case "summarization_retry_finished": {
				this.clearStatusIndicator("retry");
				this.renderer.requestRender();
				break;
			}
		}
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/** Show a managed-tool status update in the chat. */
	private showManagedToolStatus(status: ToolStatus): void {
		if (!this.managedToolStatusStarted) {
			this.chatContainer.addChild(new Spacer(1));
			this.managedToolStatusStarted = true;
		}
		const message = status.type === "warning" ? `Warning: ${status.message}` : status.message;
		const color = status.type === "warning" ? "warning" : "dim";
		this.chatContainer.addChild(new Text(theme.fg(color, message), 1, 0));
		this.renderer.requestRender();
	}

	private showStatus(message: string): void {
		this.notification.show(message);
	}

	private addCustomEntryToChat(entry: Extract<SessionEntry, { type: "custom" }>): void {
		if (entry.customType === "tps") {
			if (typeof entry.data !== "string") throw new Error("TPS entry must contain a text summary");
			const assistant = this.chatContainer.children.findLast((child) => child instanceof AssistantMessageComponent);
			if (assistant instanceof AssistantMessageComponent) assistant.setStats(entry.data);
			return;
		}
		const renderer = this.session.extensionRunner.getEntryRenderer(entry.customType);
		if (!renderer) {
			return;
		}
		const component = new CustomEntryComponent(entry, renderer);
		component.setExpanded(this.toolOutputExpanded);
		if (!component.hasContent()) {
			return;
		}

		if (this.sessionPresentation.streamingComponent) {
			const streamingIndex = this.chatContainer.children.indexOf(this.sessionPresentation.streamingComponent);
			if (streamingIndex >= 0) {
				this.chatContainer.children.splice(streamingIndex, 0, component);
				return;
			}
		}

		this.chatContainer.addChild(component);
	}

	private updateTranscriptAnimationOptions(): void {
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent)
				child.setAnimationOptions(
					this.settingsManager.getUiAnimations(),
					this.settingsManager.getAnimationIntensity(),
					() => this.renderer.requestRender(),
				);
		}
	}

	private addToolToChat(component: ToolExecutionComponent): void {
		this.dismissHome();
		const previous = this.chatContainer.children.at(-1);
		if (previous instanceof ToolExecutionComponent) previous.setContinuesActivity(true);
		this.chatContainer.addChild(component);
	}

	private dismissHome(): void {
		if (this.splashComponent) {
			this.chatContainer.removeChild(this.splashComponent);
			this.splashComponent = undefined;
		}
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		if (message.role !== "system") this.dismissHome();
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(
					message.command,
					this.renderer,
					message.excludeFromContext,
					this.settingsManager.getToolPreviewLines(),
				);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const renderer = this.session.extensionRunner.getMessageRenderer(message.customType);
					const component = new CustomMessageComponent(
						message,
						renderer,
						this.getMarkdownThemeWithSettings(),
						this.outputPad,
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "system":
				break;
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (
					textContent ||
					(typeof message.content !== "string" && message.content.some((part) => part.type === "image"))
				) {
					this.chatContainer.addChild(new Spacer(this.chatContainer.children.length === 0 ? 2 : 1));
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							this.chatContainer.addChild(new Spacer(1));
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
								this.outputPad,
								this.getMarkdownTransformers(),
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(
							textContent,
							this.getMarkdownThemeWithSettings(),
							this.outputPad,
							this.getMarkdownTransformers(),
						);
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
					this.outputPad,
					this.getMarkdownTransformers(),
					this.mermaidCodeBlockView,
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
		}
	}

	private renderSessionItems(
		items: readonly RenderSessionItem[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.pendingTools.clear();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();
		// Cache misses are not persisted, unlike successful cache-warming usage.
		// Re-derive them and inject them after the assistant messages that paid for them.
		const cacheMisses = this.settingsManager.getShowCacheMissNotices()
			? collectCacheMisses(this.sessionManager.getEntries(), this.session.modelRuntime)
			: new Map<AssistantMessage, CacheMiss>();

		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		for (const item of items) {
			if (isCustomSessionEntry(item)) {
				this.addCustomEntryToChat(item);
				continue;
			}
			if (isUsageSessionEntry(item)) {
				this.addCacheWarmingUsage(item);
				continue;
			}
			if (isCompactionCostNotice(item)) {
				this.addCompactionCostNotice(item);
				continue;
			}

			const message = item;
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{
								showImages: this.settingsManager.getShowImages(),
								imageWidthCells: this.settingsManager.getImageWidthCells(),
								toolPreviewLines: this.settingsManager.getToolPreviewLines(),
							},
							this.getRegisteredToolDefinition(content.name),
							this.renderer,
							this.sessionManager.getCwd(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.addToolToChat(component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
							if (message.stopReason === "aborted") component.markCancelled();
						} else {
							renderedPendingTools.set(content.id, component);
						}
					}
				}
				if (message.stopReason !== "aborted" && message.stopReason !== "error") {
					const miss = cacheMisses.get(message);
					if (miss) this.addCacheMissNotice(miss);
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					if (message.cancelled) component.markCancelled();
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		for (const [toolCallId, component] of renderedPendingTools) {
			this.pendingTools.set(toolCallId, component);
		}
		this.renderer.requestRender();
	}

	/**
	 * Render session entries to chat. Used for initial load and rebuild after compaction.
	 * @param entries Compaction-aware session entries to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionEntries(
		entries: SessionEntry[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		const items = this.sessionPresentation.projectEntries(entries);
		this.renderSessionItems(items, options);
	}

	private addCacheWarmingUsage(entry: UsageEntry): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", formatCacheWarmingUsage(entry)), 1, 0));
	}

	/**
	 * Render billing usage for a compaction or branch summary. The notice is derived
	 * from persisted summary usage and is not stored as a separate session entry.
	 */
	private addCompactionCostNotice(notice: CompactionCostNotice): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		const { usage } = notice;
		const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		const cost = usage.cost.total >= 0.01 ? ` (~$${usage.cost.total.toFixed(2)})` : "";
		const label = notice.kind === "compaction" ? "Compaction" : "Branch summary";
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(theme.fg("warning", `${label}: ${formatTokens(tokens)} tokens billed${cost}`), 1, 0),
		);
	}

	private static countDroppedThinkingBlocks(message: AssistantMessage): number {
		let count = 0;
		for (const diagnostic of message.diagnostics ?? []) {
			if (diagnostic.type !== "anthropic_input_transformations") continue;
			const transformations = diagnostic.details?.transformations;
			if (!Array.isArray(transformations)) continue;
			count += transformations.filter(
				(transformation) =>
					typeof transformation === "object" &&
					transformation !== null &&
					(transformation as Record<string, unknown>).type === "thinking_dropped",
			).length;
		}
		return count;
	}

	private maybeShowThinkingDropNotice(message: AssistantMessage): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		const droppedCount = InteractiveMode.countDroppedThinkingBlocks(message);
		if (droppedCount === 0) return;

		let previousDroppedCount = 0;
		// message_end reaches the UI before the current message is persisted,
		// so the branch's last assistant message is the previous response.
		const branch = this.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				previousDroppedCount = InteractiveMode.countDroppedThinkingBlocks(entry.message);
				break;
			}
		}
		if (droppedCount <= previousDroppedCount) return;

		const noun = droppedCount === 1 ? "thinking block" : "thinking blocks";
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(theme.fg("warning", `Anthropic dropped ${droppedCount} ${noun} (details in session)`), 1, 0),
		);
	}

	/**
	 * Show a transcript notice when a completed assistant message paid for a
	 * significant cache miss. Only states observable facts: the miss itself,
	 * a model switch, or an idle gap past the cache TTL.
	 */
	private maybeShowCacheMissNotice(message: AssistantMessage): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		// Entries don't contain `message` yet: message_end fires before persistence.
		const miss = detectCacheMiss(this.sessionManager.getEntries(), message, this.session.modelRuntime);
		if (miss) this.addCacheMissNotice(miss);
	}

	private addCacheMissNotice(miss: CacheMiss): void {
		if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return;

		const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
		const reBilled = `${formatTokens(miss.missedTokens)} tokens re-billed${cost}`;
		let label = "Cache miss";
		if (miss.modelChanged) {
			label = "Cache miss after model switch";
		} else if (miss.idleMs >= CACHE_TTL_MS) {
			label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`;
		}
		const text = theme.fg("warning", `${label}: ${reBilled}`);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(text, 1, 0));
	}

	private getHomeResources(): SplashResources {
		const loader = this.session.resourceLoader;
		return {
			context:
				(loader.getSystemPromptSource() ? 1 : 0) +
				loader.getAppendSystemPromptSources().length +
				loader.getAgentsFiles().agentsFiles.length,
			skills: loader.getSkills().skills.length,
			prompts: this.session.promptTemplates.length,
			extensions: loader.getExtensions().extensions.filter((extension) => !extension.hidden).length,
		};
	}

	private renderEmptySessionHome(): void {
		this.splashComponent = new SplashComponent({
			version: this.version,
			resources: this.getHomeResources(),
			getAvailableHeight: () =>
				Math.max(6, this.renderer.terminal.rows - this.editor.render(this.renderer.terminal.columns).length - 3),
		});
		this.chatContainer.addChild(this.splashComponent);
	}

	renderInitialMessages(): void {
		const entries = this.sessionManager.buildContextEntries();
		this.renderSessionEntries(entries, {
			updateFooter: true,
			populateHistory: true,
		});
		if (this.chatContainer.children.length === 0) this.renderEmptySessionHome();
		this.renderProjectTrustWarningIfNeeded();

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	private renderProjectTrustWarningIfNeeded(): void {
		if (this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(this.sessionManager.getCwd())) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(
			new Text(
				theme.fg(
					"warning",
					`This project is not trusted. Project ${CONFIG_DIR_NAME} resources and packages are ignored. Choose Trust in Command to save a trust decision, then restart candy.`,
				),
				1,
				0,
			),
		);
	}

	async getUserInput(): Promise<QueuedInput> {
		const queuedInput = this.pendingUserInputs.shift();
		if (queuedInput !== undefined) {
			return queuedInput;
		}

		return new Promise((resolve) => {
			this.onInputCallback = (input: QueuedInput) => {
				this.onInputCallback = undefined;
				resolve(input);
			};
		});
	}

	private createEditorInput(
		text: string,
		imagePaths = this.editor.getPastePaths?.() ?? [],
		promptText?: string,
	): QueuedInput {
		text = (promptText ?? this.editor.getPromptText?.() ?? text).trim();
		if (imagePaths.length === 0) return { text };
		const images = imagePaths.map((filePath) => {
			const bytes = fs.readFileSync(filePath);
			const mimeType = detectSupportedImageMimeType(bytes);
			if (!mimeType) throw new Error(`Unsupported image attachment: ${filePath}`);
			return { type: "image" as const, data: bytes.toString("base64"), mimeType };
		});
		return { text, images };
	}

	private rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		this.renderSessionEntries(this.sessionManager.buildContextEntries());
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		if (this.inputMode !== "normal") {
			this.clearEditor();
			this.lastSigintTime = 0;
			return;
		}
		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	private isShuttingDown = false;

	private async shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		// Keep signal handlers registered until terminal cleanup has completed.
		// `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
		// dispatch and re-sends the signal if only its own listeners remain.

		if (options?.fromSignal) {
			// Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
			// (session_shutdown) BEFORE touching the terminal. Extension teardown
			// such as removing sockets does not write to the tty, so it must not be
			// skipped if a later terminal-restore write fails on a dead or stalled
			// terminal. If the terminal is gone, the restore writes below emit EIO,
			// which the stdout/stderr error handler turns into emergencyTerminalExit;
			// the render loop is already idle, so this cannot hot-spin (see #4144).
			await this.runtimeHost.dispose();
			this.themeController.disableAutoSync();
			await this.renderer.terminal.drainInput(1000);
			this.stop();
			process.exit(0);
		}

		// Interactive quit (Ctrl+D, Ctrl+C, Command Quit, extension shutdown()). Stop the
		// TUI before emitting shutdown events so extension UI cleanup cannot repaint
		// the final frame while the process is exiting.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		this.themeController.disableAutoSync();
		await this.renderer.terminal.drainInput(1000);

		this.stop();
		await this.runtimeHost.dispose();

		const resumeCommand = formatResumeCommand(this.sessionManager);
		if (resumeCommand) {
			process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
		}

		process.exit(0);
	}

	private emergencyTerminalExit(): never {
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		process.exit(129);
	}

	/**
	 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
	 * mode and hides the cursor; without this handler, an uncaught throw from
	 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
	 * tears down the process while leaving the terminal in raw mode with no
	 * cursor, requiring `stty sane && reset` to recover.
	 *
	 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
	 * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
	 * paste / Kitty / modifyOtherKeys sequences.
	 */
	private uncaughtCrash(error: Error): never {
		if (this.isShuttingDown) {
			process.exit(1);
		}
		this.isShuttingDown = true;
		try {
			this.unregisterSignalHandlers();
		} catch {}
		try {
			killTrackedDetachedChildren();
		} catch {}
		try {
			this.renderer.stop();
		} catch {}
		console.error(`${APP_NAME} exiting due to uncaughtException:`);
		console.error(error);
		const extensionHint = this.getCrashExtensionHint(error);
		if (extensionHint) console.error(`\n${extensionHint}`);
		process.exit(1);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
				// first, then attempts terminal restore. A genuinely dead terminal
				// surfaces as an EIO on the restore writes, which the stdout/stderr
				// error handler converts into emergencyTerminalExit (see #4144, #5080).
				killTrackedDetachedChildren();
				void this.shutdown({ fromSignal: true });
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));

		// Restore the terminal before the process dies on any uncaught throw.
		// Without this, an unhandled exception from extension code (or anywhere
		// in candy) leaves the terminal in raw mode with no cursor.
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Suspend to background is not supported on Windows");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.renderer.start();
			this.renderer.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode)
			this.renderer.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	private async handleFollowUp(): Promise<void> {
		if (this.inputMode !== "normal") return;
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;
		let input: QueuedInput;
		try {
			input = this.createEditorInput(text);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		if (this.session.isCompacting) {
			this.queueCompactionMessage(input, "followUp");
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		if (this.session.isStreaming) {
			this.editor.addToHistory?.(input.text);
			this.editor.setText("");
			try {
				await this.session.prompt(input.text, { images: input.images, streamingBehavior: "followUp" });
			} catch (error) {
				this.restoreInputToEditor(input);
				this.showError(`Failed to queue message: ${error instanceof Error ? error.message : String(error)}`);
			}
			this.updatePendingMessagesDisplay();
			this.renderer.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			this.editor.setText("");
			this.editor.onSubmit(text);
		}
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private updateEditorBorderColor(): void {
		this.defaultEditor.setThinkingLevel(this.session.thinkingLevel || "off");
		if (this.inputMode === "help") {
			this.editor.borderColor = (text) => theme.fg("borderAccent", text);
		} else if (this.inputMode !== "normal") {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.session.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.activeStatusIndicator?.invalidate();
		this.renderer.requestRender();
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		if (expanded === this.toolOutputExpanded) return;

		this.toolOutputExpanded = expanded;
		const activeHeader = this.customHeader ?? this.builtInHeader;
		if (isExpandable(activeHeader)) {
			activeHeader.setExpanded(expanded);
		}
		for (const child of this.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		this.showStatus(`Details ${expanded ? "expanded" : "collapsed"}`);
	}

	/** Update rendered assistant messages without rebuilding live tool components. */
	private updateThinkingBlockVisibility(): void {
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHideThinkingBlock(this.hideThinkingBlock);
			}
		}
		this.renderer.requestRender();
	}

	private async toggleThinkingBlockVisibility(): Promise<void> {
		const hideThinkingBlock = !this.hideThinkingBlock;
		try {
			await this.settingsManager.commitSetting("global", "hideThinkingBlock", hideThinkingBlock);
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		this.hideThinkingBlock = hideThinkingBlock;
		this.updateThinkingBlockVisibility();
		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private async handleOpenExternalEditor(): Promise<void> {
		const editorCmd = this.settingsManager.getExternalEditorCommand();
		const content = this.editor.getExpandedText?.() ?? this.editor.getText();
		this.renderer.stop();
		try {
			const result = await editInExternalEditor({
				command: editorCmd,
				content,
			});
			if (result.status === "complete") {
				this.editor.setText(result.content);
			}
		} finally {
			this.renderer.start();
			this.renderer.requestRender(true);
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.editor.setText("");
		this.renderer.requestRender();
	}

	showError(errorMessage: string, title = "Error"): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new TranscriptNotice({ tone: "error", title, body: errorMessage }));
		this.renderer.requestRender();
	}

	showWarning(warningMessage: string, title = "Warning"): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new TranscriptNotice({ tone: "warning", title, body: warningMessage }));
		this.renderer.requestRender();
	}

	showPackageUpdateNotification(packages: string[]): void {
		const title = `Package updates · ${packages.length}`;
		const content = `Run \`${APP_NAME} update --extensions\`.\n\n${packages.map((pkg) => `- ${pkg}`).join("\n")}`;
		this.chatContainer.addChild(
			new TranscriptNotice({ tone: "info", title, body: "", onOpen: () => this.showReader(title, content) }),
		);
		this.renderer.requestRender();
	}

	/** Get queued messages from the session. */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: [...this.session.getSteeringMessages()],
			followUp: [...this.session.getFollowUpMessages()],
		};
	}

	private clearAllQueues(): { steering: QueuedInput[]; followUp: QueuedInput[] } {
		return this.session.clearQueue();
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const { steering, followUp } = this.getAllQueuedMessages();
		if (steering.length || followUp.length) {
			this.pendingMessagesContainer.addChild(
				new QueuedMessagesComponent(steering, followUp, this.getAppKeyDisplay("app.message.dequeue")),
			);
		}
		for (const component of this.pendingBashComponents) this.pendingMessagesContainer.addChild(component);
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.clearAllQueues();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				void this.session.abort();
			}
			return 0;
		}
		const currentText = options?.currentText ?? this.editor.getExpandedText?.() ?? this.editor.getText();
		const currentInput = this.createEditorInput(currentText);
		const queuedText = allQueued.map((input) => omitImageMarkers(input.text)).join("\n\n");
		const combinedText = [queuedText, omitImageMarkers(currentInput.text)].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.restoreImagesToEditor([...allQueued.flatMap((input) => input.images ?? []), ...(currentInput.images ?? [])]);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			void this.session.abort();
		}
		return allQueued.length;
	}

	private queueCompactionMessage(input: QueuedInput, mode: "steer" | "followUp"): void {
		this.editor.addToHistory?.(input.text);
		this.editor.setText("");
		void this.session.prompt(input.text, { images: input.images, streamingBehavior: mode }).catch((error) => {
			this.restoreInputToEditor(input);
			this.updatePendingMessagesDisplay();
			this.showError(`Failed to send queued message: ${error instanceof Error ? error.message : String(error)}`);
		});
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private restoreInputToEditor(input: QueuedInput): void {
		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		const currentInput = this.createEditorInput(currentText);
		const text = [omitImageMarkers(input.text), omitImageMarkers(currentInput.text)]
			.filter((value) => value.trim())
			.join("\n\n");
		this.editor.setText(text);
		this.restoreImagesToEditor([...(input.images ?? []), ...(currentInput.images ?? [])]);
	}

	private restoreImagesToEditor(images: ImageContent[]): void {
		for (const image of images) {
			if (!this.editor.insertImageAtCursor) throw new Error("The active editor cannot restore image attachments");
			const extension = extensionForImageMimeType(image.mimeType);
			if (!extension) throw new Error(`Unsupported image attachment type: ${image.mimeType}`);
			const filePath = path.join(os.tmpdir(), `candy-restored-${crypto.randomUUID()}.${extension}`);
			fs.writeFileSync(filePath, Buffer.from(image.data, "base64"));
			const dimensions = getImageDimensions(image.data, image.mimeType);
			if (!dimensions) throw new Error(`Could not read dimensions for image attachment: ${filePath}`);
			this.editor.insertImageAtCursor(filePath, { width: dimensions.widthPx, height: dimensions.heightPx });
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	private buildSettingsDefinition(done: () => void): ReturnType<typeof createSettingsDefinition> {
		const definition = createSettingsDefinition(
			this.settingsManager,
			{
				currentTheme: this.themeController.getThemeSelection() || "dark",
				terminalTheme: this.themeController.getTerminalTheme(),
				availableThemes: getAvailableThemes(),
			},
			{
				onInteractiveSettingChange: async (id, value) => {
					const { source } = getInteractiveSettingState(this.settingsManager, id);
					const scope = source === "project" ? "project" : "global";
					await commitInteractiveSetting(this.settingsManager, scope, id, value);
					switch (id) {
						case "tool-preview-lines": {
							const lines = this.settingsManager.getToolPreviewLines();
							for (const child of this.chatContainer.children) {
								if (child instanceof ToolExecutionComponent) child.setToolPreviewLines(lines);
								if (child instanceof BashExecutionComponent) child.setPreviewLines(lines);
							}
							for (const child of this.pendingBashComponents) child.setPreviewLines(lines);
							this.renderer.requestRender();
							break;
						}
						case "show-images": {
							const enabled = this.settingsManager.getShowImages();
							for (const child of this.chatContainer.children) {
								if (child instanceof ToolExecutionComponent) child.setShowImages(enabled);
							}
							break;
						}
						case "image-width-cells": {
							const width = this.settingsManager.getImageWidthCells();
							for (const child of this.chatContainer.children) {
								if (child instanceof ToolExecutionComponent) child.setImageWidthCells(width);
							}
							break;
						}
						case "skill-commands":
							this.setupAutocompleteProvider();
							break;
						case "ui-animations": {
							const enabled = this.settingsManager.getUiAnimations();
							const intensity = this.settingsManager.getAnimationIntensity();
							this.defaultEditor.setAnimationOptions(enabled, intensity);
							this.composerPanel.setOptions(enabled, intensity);
							this.helpPanel?.setOptions(enabled, intensity);
							this.topBar.setAnimations(enabled);
							this.footer.setAnimationOptions(enabled, intensity);
							this.updateTranscriptAnimationOptions();
							break;
						}
						case "animation-intensity": {
							const enabled = this.settingsManager.getUiAnimations();
							const intensity = this.settingsManager.getAnimationIntensity();
							this.defaultEditor.setAnimationOptions(enabled, intensity);
							this.composerPanel.setOptions(enabled, intensity);
							this.helpPanel?.setOptions(enabled, intensity);
							this.footer.setAnimationOptions(enabled, intensity);
							this.updateTranscriptAnimationOptions();
							break;
						}
						case "hide-thinking":
							this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
							this.updateThinkingBlockVisibility();
							break;
						case "mermaid-rendering":
							this.chatContainer.invalidate();
							this.renderer.requestRender();
							break;
						case "cache-miss-notices":
							this.rebuildChatFromMessages();
							break;
						case "show-hardware-cursor":
							this.renderer.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
							break;
						case "editor-padding": {
							const padding = this.settingsManager.getEditorPaddingX();
							this.defaultEditor.setPaddingX(padding);
							if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
								this.editor.setPaddingX(padding);
							}
							break;
						}
						case "output-padding": {
							const padding = this.settingsManager.getOutputPad();
							this.outputPad = padding;
							if (this.sessionPresentation.streamingComponent || this.session.isStreaming) {
								for (const child of this.chatContainer.children) {
									if (
										child instanceof AssistantMessageComponent ||
										child instanceof CustomMessageComponent ||
										child instanceof UserMessageComponent
									) {
										child.setOutputPad(padding);
									}
								}
								this.sessionPresentation.streamingComponent?.setOutputPad(padding);
								this.renderer.requestRender();
								break;
							}
							this.rebuildChatFromMessages();
							break;
						}
						case "autocomplete-max-visible": {
							const maxVisible = this.settingsManager.getAutocompleteMaxVisible();
							this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
							if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
								this.editor.setAutocompleteMaxVisible(maxVisible);
							}
							break;
						}
						case "clear-on-shrink":
							this.renderer.setClearOnShrink(this.settingsManager.getClearOnShrink());
							if (!this.settingsManager.getClearOnShrink() && !this.activeStatusIndicator) {
								this.statusContainer.clear();
								this.statusContainer.addChild(this.notification);
							}
							break;
						case "fullscreen-scrollbar":
							this.applyFullscreenScrollbarSetting();
							break;
						case "fullscreen-copy-on-select":
							this.renderer.setCopyOnSelect(this.settingsManager.getFullscreenCopyOnSelect());
							break;
					}
				},
				onThemeChange: async (themeSetting) => {
					await this.settingsManager.commitSetting("global", "theme", themeSetting);
					await this.themeController.setThemeSetting(themeSetting);
				},
				onThemePreview: (themeName) => this.themeController.preview(themeName),
				onCancel: () => {
					done();
					this.renderer.requestRender();
				},
			},
		);
		return definition;
	}

	private selectThinkingLevel(level: ThinkingLevel): void {
		try {
			this.session.setThinkingLevel(level);
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Thinking level: ${level}`);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	/** Powerbar dependencies: selectors read live session state through these callbacks. */
	private buildPowerbarHost(): PowerbarHost {
		return {
			requestRender: () => this.renderer.requestRender(),
			getThinkingLevels: () => this.session.getAvailableThinkingLevels(),
			getThinkingLevel: () => this.session.thinkingLevel || DEFAULT_THINKING_LEVEL,
			getModels: () => this.getPowerbarModels(),
			getCurrentModelIndex: () => {
				const models = this.getPowerbarModels();
				const current = this.session.model;
				const index = models.findIndex(
					(entry) => entry.model.provider === current?.provider && entry.model.id === current?.id,
				);
				return index === -1 ? 0 : index;
			},
			applyThinking: (level) => this.selectThinkingLevel(level),
			applyModel: (model) => void this.applyPowerbarModel(model),
		};
	}

	private getPowerbarModels(): PowerbarModelEntry[] {
		return getQuickSelectionModels(this.session).map((model) => ({ model, label: modelDisplayName(model) }));
	}

	private async applyQuickSelection(signal: AbortSignal): Promise<void> {
		const session = this.session;
		try {
			const result = await reconcileQuickSelection(session, signal);
			if (signal.aborted || this.session !== session) return;
			if (result !== "unchanged") {
				this.powerbarReturn = undefined;
				if (result === "empty") {
					const scope = this.settingsManager.getScopedModels();
					this.showError(
						"Open Sources to select a model",
						scope?.length === 0 ? "No models selected" : "No selected models available",
					);
				}
			}
		} catch (error) {
			if (signal.aborted || this.session !== session) return;
			this.powerbarReturn = undefined;
			this.showError(error instanceof Error ? error.message : String(error), "Model selection failed");
		}
		if (signal.aborted || this.session !== session) return;
		this.footer.invalidate();
		this.refreshContextLine();
		this.updateEditorBorderColor();
		await this.updateAvailableProviderCount();
	}

	private async applyPowerbarModel(model: Model<any>): Promise<void> {
		try {
			await this.session.setModel(model);
			this.updateAvailableProviderCount();
			this.footer.invalidate();
			this.refreshContextLine();
			this.updateEditorBorderColor();
			void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * Route a key to the active Powerbar selector. Returns false when the footer
	 * is idle or the key should fall through to the editor (exit/suspend/clear).
	 */
	private handlePowerbarKey(data: string): boolean {
		if (this.footer.isPowerbarIdle()) return false;
		const kb = this.keybindings;
		if (kb.matches(data, "app.powerbar.next")) {
			this.footer.switchPowerbar();
			return true;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.footer.cancelPowerbar();
			return true;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.footer.confirmPowerbar();
			return true;
		}
		if (kb.matches(data, "app.powerbar.up") || kb.matches(data, "app.powerbar.down")) {
			const up = kb.matches(data, "app.powerbar.up");
			const selector = this.footer.getPowerbarSelector();
			const model = this.footer.getHighlightedModel();
			if (selector === "model" && !up && !model) return true;
			this.openPresentation(selector === "model" ? (up ? "sources" : "details") : up ? "history" : "agent", model);
			return true;
		}
		if (kb.matches(data, "app.powerbar.left")) {
			this.footer.movePowerbar(-1);
			return true;
		}
		if (kb.matches(data, "app.powerbar.right")) {
			this.footer.movePowerbar(1);
			return true;
		}
		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			this.footer.powerbarBackspace();
			return true;
		}
		if (kb.matches(data, "app.clear") || kb.matches(data, "app.exit") || kb.matches(data, "app.suspend")) {
			return false;
		}
		const printable =
			decodeKittyPrintable(data) ?? (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
		if (printable) {
			this.footer.powerbarInputChar(printable);
		}
		// Swallow remaining keys so the selector cannot edit the composer text.
		return true;
	}

	/** Update the footer's available provider count from the current snapshot without refreshing catalogs. */
	private updateAvailableProviderCount(): void {
		const models = this.session.modelRuntime.getAvailableSnapshot();
		const uniqueProviders = new Set(models.map((model) => model.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private async maybeWarnAboutAnthropicSubscriptionAuth(
		model: Model<any> | undefined = this.session.model,
	): Promise<void> {
		if (this.settingsManager.getWarnings().anthropicExtraUsage === false) {
			return;
		}
		if (this.anthropicSubscriptionWarningShown) {
			return;
		}
		if (!model || model.provider !== "anthropic") {
			return;
		}

		try {
			if ((await this.session.modelRuntime.checkAuth("anthropic"))?.type === "oauth") {
				this.anthropicSubscriptionWarningShown = true;
				this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
				return;
			}
			const apiKey = (await this.session.modelRuntime.getAuth(model.provider))?.auth.apiKey;
			if (!isAnthropicSubscriptionAuthKey(apiKey)) {
				return;
			}
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
		} catch {
			// Ignore auth lookup failures for warning-only checks.
		}
	}

	private maybeSaveImplicitProjectTrustAfterReload(): boolean {
		const cwd = this.sessionManager.getCwd();
		if (this.autoTrustOnReloadCwd !== cwd) {
			return false;
		}
		if (!this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd)) {
			return false;
		}

		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		try {
			if (trustStore.get(cwd) !== null) {
				this.autoTrustOnReloadCwd = undefined;
				return false;
			}
			trustStore.set(cwd, true);
			this.autoTrustOnReloadCwd = undefined;
			return true;
		} catch (error) {
			this.showWarning(
				`Could not save project trust after reload: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	private promptProjectTrust(
		cwd: string,
		savedDecision: ProjectTrustStoreEntry | null,
		projectTrusted: boolean,
	): Promise<TrustSelection | undefined> {
		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		return new Promise((resolve) => {
			this.pageController.showSelector((done) => {
				const selector = new TrustSelectorComponent({
					cwd,
					savedDecision,
					projectTrusted,
					onSelect: (selection) => {
						trustStore.setMany(selection.updates);
						done();
						resolve(selection);
					},
					onCancel: () => {
						done();
						this.renderer.requestRender();
						resolve(undefined);
					},
				});
				return { component: selector, focus: selector };
			});
		});
	}

	private showTrustSelector(): void {
		const cwd = this.sessionManager.getCwd();
		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		void this.promptProjectTrust(cwd, trustStore.getEntry(cwd), this.settingsManager.isProjectTrusted()).then(
			(selection) => {
				if (!selection) return;
				this.showStatus(
					`Saved trust decision: ${selection.trusted ? "trusted" : "untrusted"}. Restart ${APP_NAME} for this to take effect.`,
				);
			},
		);
	}

	private showUserMessageSelector(): void {
		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

		this.pageController.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					done();
					try {
						const result = await this.runtimeHost.fork(entryId);
						if (result.cancelled) {
							this.renderer.requestRender();
							return;
						}

						this.editor.setText(result.selectedText ?? "");
						this.showStatus("Forked to new session");
					} catch (error: unknown) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.renderer.requestRender();
				},
				initialSelectedId,
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleCloneCommand(): Promise<void> {
		try {
			const result = await this.runtimeHost.clone();
			if (result.cancelled) {
				this.renderer.requestRender();
				return;
			}

			this.editor.setText("");
			this.showStatus("Cloned to new session");
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showTreeSelector(initialSelectedId?: string): void {
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.pageController.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.renderer.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === this.sessionManager.getLeafId()) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// The user committed to navigating: stop the active response first.
					if (this.session.isStreaming) {
						this.restoreQueuedMessagesToEditor();
						await this.session.abort();
					}

					// Recheck after the dialogs and streaming abort, before replacing another operation's UI.
					if (this.session.isCompacting) {
						this.showError(
							"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
						);
						return;
					}

					// Set up escape handler and status indicator if summarizing
					let showingSummaryIndicator = false;
					const originalOnEscape = this.defaultEditor.onEscape;

					if (wantsSummary) {
						this.defaultEditor.onEscape = () => {
							this.session.abortBranchSummary();
						};
						this.chatContainer.addChild(new Spacer(1));
						this.showStatusIndicator(new BranchSummaryStatusIndicator(this.renderer));
						showingSummaryIndicator = true;
						this.renderer.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (showingSummaryIndicator) {
							this.clearStatusIndicator("branchSummary");
						}
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.renderer.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.renderer.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			selector.onCopy = async (text) => {
				if (!text) {
					this.showError("Selected entry has no text to copy");
					return;
				}
				try {
					await copyToClipboard(text);
					this.showStatus("Copied selected message to clipboard");
				} catch (error) {
					this.showError(error instanceof Error ? error.message : String(error));
				}
			};
			return { component: selector, focus: selector };
		});
	}

	private showSessionSelector(): void {
		this.pageController.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress, signal) =>
					SessionManager.list(
						this.sessionManager.getCwd(),
						this.sessionManager.getSessionDir(),
						onProgress,
						signal,
					),
				(onProgress, signal) =>
					this.sessionManager.usesDefaultSessionDir()
						? SessionManager.listAll(onProgress, signal)
						: SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress, signal),
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.renderer.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.renderer.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr = SessionManager.open(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
					showRenameHint: true,
					keybindings: this.keybindings,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		this.clearStatusIndicator();
		try {
			const result = await this.runtimeHost.switchSession(sessionPath, {
				withSession: options?.withSession,
				projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
			});
			if (result.cancelled) {
				return result;
			}
			this.showStatus("Resumed session");
			return result;
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Resume cancelled");
					return { cancelled: true };
				}
				const result = await this.runtimeHost.switchSession(sessionPath, {
					cwdOverride: selectedCwd,
					withSession: options?.withSession,
					projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
				});
				if (result.cancelled) {
					return result;
				}
				this.showStatus("Resumed session in current cwd");
				return result;
			}
			return this.handleFatalRuntimeError("Failed to resume session", error);
		}
	}

	private getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
		return getAuthSelectorProviders(this.session.modelRuntime, authType);
	}

	private findLoginProviderOptions(providerRef: string): AuthSelectorProvider[] {
		const normalizedProviderRef = providerRef.trim().toLowerCase();
		if (!normalizedProviderRef) {
			return [];
		}

		return this.getLoginProviderOptions().filter(
			(provider) =>
				provider.id.toLowerCase() === normalizedProviderRef ||
				provider.name.toLowerCase() === normalizedProviderRef,
		);
	}

	private cancelActiveLogin(): void {
		const activeLogin = this.activeLogin;
		this.activeLogin = undefined;
		activeLogin?.dialog.abort();
	}

	private isActiveLogin(dialog: LoginDialogComponent): boolean {
		return this.activeLogin?.dialog === dialog && this.activeLogin.session === this.session && !dialog.signal.aborted;
	}

	private finishLoginDialog(dialog: LoginDialogComponent): boolean {
		if (this.activeLogin?.dialog !== dialog || this.activeLogin.session !== this.session) return false;
		this.activeLogin = undefined;
		this.pageController.closePanel();
		return !dialog.signal.aborted;
	}

	private async handleLoginCommand(providerRef?: string): Promise<void> {
		if (!providerRef) {
			this.showLoginAuthTypeSelector();
			return;
		}

		const providerOptions = this.findLoginProviderOptions(providerRef);
		if (providerOptions.length === 1) {
			await this.startProviderLogin(providerOptions[0]!);
			return;
		}

		if (providerOptions.length > 1) {
			const providerIds = new Set(providerOptions.map((provider) => provider.id));
			if (providerIds.size === 1) {
				this.showLoginAuthTypeSelector(providerOptions);
				return;
			}
		}

		this.showLoginProviderSelector(undefined, providerRef);
	}

	private async startProviderLogin(providerOption: AuthSelectorProvider): Promise<void> {
		if (providerOption.authType === "oauth") {
			await this.showLoginDialog(providerOption.id, providerOption.name);
		} else if (providerOption.method?.login) {
			await this.showApiKeyLoginDialog(providerOption.id, providerOption.name);
		} else {
			this.showAmbientAuthDialog(providerOption);
		}
	}

	private showLoginAuthTypeSelector(providerOptions?: AuthSelectorProvider[]): void {
		const oauthProvider = providerOptions?.find((provider) => provider.authType === "oauth");
		const oauthLoginLabel =
			oauthProvider?.method && "loginLabel" in oauthProvider.method ? oauthProvider.method.loginLabel : undefined;
		const subscriptionLabel = oauthLoginLabel ?? "Sign in with an account";
		const apiKeyLabel = "Sign in with an API key";
		const availableAuthTypes = providerOptions
			? new Set(providerOptions.map((provider) => provider.authType))
			: new Set<AuthSelectorProvider["authType"]>(["oauth", "api_key"]);
		const options: string[] = [];
		if (availableAuthTypes.has("oauth")) {
			options.push(subscriptionLabel);
		}
		if (availableAuthTypes.has("api_key")) {
			options.push(apiKeyLabel);
		}

		if (options.length === 0) {
			this.showStatus("No login methods available.");
			return;
		}

		if (providerOptions && options.length === 1) {
			const providerOption = providerOptions[0];
			if (providerOption) {
				void this.startProviderLogin(providerOption);
			}
			return;
		}

		const title = providerOptions?.[0]
			? `Select authentication method for ${providerOptions[0].name}:`
			: "Select authentication method:";
		const session = this.session;
		let generation: number;
		this.pageController.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					if (this.session !== session || this.pageController.generation !== generation) return;
					done();
					const authType = option === subscriptionLabel ? "oauth" : "api_key";
					if (providerOptions) {
						const providerOption = providerOptions.find((provider) => provider.authType === authType);
						if (providerOption) {
							void this.startProviderLogin(providerOption);
						}
						return;
					}
					this.showLoginProviderSelector(authType);
				},
				() => {
					if (this.session !== session || this.pageController.generation !== generation) return;
					done();
					this.renderer.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
		generation = this.pageController.generation;
	}

	private showLoginProviderSelector(authType?: AuthSelectorProvider["authType"], initialSearchInput?: string): void {
		const providerOptions = this.getLoginProviderOptions(authType);
		if (providerOptions.length === 0) {
			const message =
				authType === "oauth"
					? "No subscription providers available."
					: authType === "api_key"
						? "No API key providers available."
						: "No login providers available.";
			this.showStatus(message);
			return;
		}

		const session = this.session;
		let generation: number;
		this.pageController.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				"login",
				providerOptions,
				async (providerId, selectedAuthType) => {
					if (this.session !== session || this.pageController.generation !== generation) return;
					done();

					const providerOption = providerOptions.find(
						(provider) => provider.id === providerId && provider.authType === selectedAuthType,
					);
					if (!providerOption) {
						return;
					}

					await this.startProviderLogin(providerOption);
				},
				() => {
					if (this.session !== session || this.pageController.generation !== generation) return;
					done();
					if (authType) {
						this.showLoginAuthTypeSelector();
					} else {
						this.renderer.requestRender();
					}
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
		generation = this.pageController.generation;
	}

	private async completeProviderAuthentication(
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
	): Promise<void> {
		const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;

		const session = this.session;
		const generation = this.pageController.generation;
		const isCurrent = () => this.session === session && this.pageController.generation === generation;
		this.showStatus(`${actionLabel}. Refreshing model catalog…`);

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		void session.modelRuntime
			.refresh({ providers: [providerId], signal: controller.signal })
			.then(async (result) => {
				if (!isCurrent()) return;
				await this.updateAvailableProviderCount();
				if (!isCurrent()) return;
				this.footer.invalidate();
				this.refreshContextLine();
				this.updateEditorBorderColor();
				const error = result.errors.get(providerId);
				if (result.aborted) this.showWarning(`${actionLabel}, but the model catalog refresh timed out.`);
				else if (error) this.showWarning(`${actionLabel}, but the model catalog refresh failed: ${error.message}`);
				else this.showStatus(`${actionLabel}. Credentials saved to ${getAuthPath()}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth();
				this.renderer.requestRender();
			})
			.catch((error: unknown) => {
				if (!isCurrent()) return;
				this.showWarning(
					`${actionLabel}, but its model catalog could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
				);
			})
			.finally(() => clearTimeout(timeout));
	}

	private showAmbientAuthDialog(providerOption: AuthSelectorProvider): void {
		const session = this.session;
		let generation: number;
		const restoreEditor = () => {
			if (this.session === session && this.pageController.generation === generation)
				this.pageController.closePanel();
		};

		const dialog = new LoginDialogComponent(
			this.renderer,
			providerOption.id,
			() => restoreEditor(),
			providerOption.name,
			`${providerOption.name} setup`,
		);
		dialog.showInfo(
			`${providerOption.method?.name ?? "Authentication"} is configured outside ${APP_NAME}.`,
			[],
			true,
		);

		this.pageController.mountPanel(dialog, 0.5);
		generation = this.pageController.generation;
	}

	private async showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void> {
		const session = this.session;

		const dialog = new LoginDialogComponent(
			this.renderer,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
		);

		this.activeLogin = { dialog, session };
		this.pageController.mountPanel(dialog, 0.5);

		try {
			await this.loginProvider(dialog, providerId, "api_key");
		} catch (error: unknown) {
			if (!this.finishLoginDialog(dialog)) return;
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (error instanceof CredentialSynchronizationError) {
				this.showError(
					`Saved API key for ${providerName}, but local model state could not be synchronized: ${errorMsg}`,
				);
			} else if (!dialog.signal.aborted) {
				this.showError(`${providerName}: ${errorMsg}`, "Could not save API key");
			}
			return;
		}
		if (!this.finishLoginDialog(dialog)) return;
		await this.completeProviderAuthentication(providerId, providerName, "api_key");
	}

	private showAuthSelect(
		dialog: LoginDialogComponent,
		prompt: Extract<AuthPrompt, { type: "select" }>,
	): Promise<string> {
		return new Promise((resolve, reject) => {
			let generation: number;
			const restoreDialog = () => {
				if (!this.isActiveLogin(dialog) || this.pageController.generation !== generation) return false;
				this.pageController.mountPanel(dialog, 0.5);
				return true;
			};
			const onAbort = () => reject(new Error("Login cancelled"));
			dialog.signal.addEventListener("abort", onAbort, { once: true });
			const finish = (value?: string) => {
				dialog.signal.removeEventListener("abort", onAbort);
				if (!restoreDialog()) return;
				if (value) resolve(value);
				else {
					dialog.abort();
					reject(dialog.signal.reason);
				}
			};
			const labels = prompt.options.map((option) => option.label);
			const selector = new ExtensionSelectorComponent(
				prompt.message,
				labels,
				(optionLabel) => {
					const id = prompt.options.find((option) => option.label === optionLabel)?.id;
					finish(id);
				},
				() => finish(),
			);
			this.pageController.mountPanel(selector, 0.5);
			generation = this.pageController.generation;
		});
	}

	private async showAuthPrompt(dialog: LoginDialogComponent, prompt: AuthPrompt, secret: boolean): Promise<string> {
		if (!this.isActiveLogin(dialog) || prompt.signal?.aborted) throw new Error("Login cancelled");
		let response: Promise<string>;
		if (prompt.type === "select") {
			response = this.showAuthSelect(dialog, prompt);
		} else if (prompt.type === "manual_code") {
			response = dialog.showManualInput(prompt.message);
		} else {
			response = dialog.showPrompt(prompt.message, prompt.placeholder, secret);
		}
		const signals = prompt.signal ? [dialog.signal, prompt.signal] : [dialog.signal];
		if (signals.some((signal) => signal.aborted)) throw new Error("Login cancelled");
		const onAbort = () => rejectAbort(new Error("Login cancelled"));
		let rejectAbort: (error: Error) => void;
		const aborted = new Promise<string>((_resolve, reject) => {
			rejectAbort = reject;
			for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([response, aborted]);
		} finally {
			for (const signal of signals) signal.removeEventListener("abort", onAbort);
		}
	}

	private notifyAuthDialog(dialog: LoginDialogComponent, event: AuthEvent): void {
		if (!this.isActiveLogin(dialog)) return;
		if (event.type === "auth_url") {
			dialog.showAuth(event.url, event.instructions);
		} else if (event.type === "device_code") {
			dialog.showDeviceCode(event);
			dialog.showWaiting("Waiting for authentication...");
		} else if (event.type === "info") {
			dialog.showInfo(event.message, event.links);
		} else {
			dialog.showProgress(event.message);
		}
	}

	private async loginProvider(
		dialog: LoginDialogComponent,
		providerId: string,
		method: "api_key" | "oauth",
	): Promise<void> {
		const session = this.session;
		await session.modelRuntime.login(providerId, method, {
			signal: dialog.signal,
			prompt: (prompt) => this.showAuthPrompt(dialog, prompt, method === "api_key"),
			notify: (event) => this.notifyAuthDialog(dialog, event),
		});
	}

	private async showLoginDialog(providerId: string, providerName: string): Promise<void> {
		const session = this.session;
		const dialog = new LoginDialogComponent(this.renderer, providerId, (_success, _message) => {}, providerName);
		this.activeLogin = { dialog, session };
		this.pageController.mountPanel(dialog, 0.5);

		try {
			await this.loginProvider(dialog, providerId, "oauth");
		} catch (error: unknown) {
			if (!this.finishLoginDialog(dialog)) return;
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (error instanceof CredentialSynchronizationError) {
				this.showError(
					`Logged in to ${providerName}, but local model state could not be synchronized: ${errorMsg}`,
				);
			} else if (!dialog.signal.aborted) {
				this.showError(`${providerName}: ${errorMsg}`, "Authentication failed");
			}
			return;
		}
		if (!this.finishLoginDialog(dialog)) return;
		await this.completeProviderAuthentication(providerId, providerName, "oauth");
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private async handleReloadCommand(): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return;
		}

		this.resetExtensionUI();

		const reloadBox = new Container();
		const borderColor = (s: string) => theme.fg("border", s);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(
			new Text(
				theme.fg("muted", "Reloading keybindings, extensions, skills, prompts, themes, and context files..."),
				1,
				0,
			),
		);
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));

		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(reloadBox);
		this.renderer.setFocus(reloadBox);
		this.renderer.requestRender(true);
		await new Promise((resolve) => process.nextTick(resolve));

		const dismissReloadBox = (editor: Component) => {
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.renderer.setFocus(editor);
			this.renderer.requestRender();
		};

		let chatRestoredBeforeSessionStart = false;
		let reloadBoxDismissed = false;
		const restoreChatBeforeSessionStart = () => {
			if (chatRestoredBeforeSessionStart) {
				return;
			}
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			this.outputPad = this.settingsManager.getOutputPad();
			this.rebuildChatFromMessages();
			chatRestoredBeforeSessionStart = true;
		};

		try {
			await this.session.reload({ beforeSessionStart: restoreChatBeforeSessionStart });
			restoreChatBeforeSessionStart();
			this.keybindings.reload();
			const activeHeader = this.customHeader ?? this.builtInHeader;
			if (isExpandable(activeHeader)) {
				activeHeader.setExpanded(this.toolOutputExpanded);
			}
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.applyRuntimeSettings();
			await this.themeController.applyFromSettings();
			this.setupAutocompleteProvider();
			const runner = this.session.extensionRunner;
			this.setupExtensionShortcuts(runner);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const savedImplicitProjectTrust = this.maybeSaveImplicitProjectTrustAfterReload();
			const modelsJsonError = this.session.modelRuntime.getError();
			if (modelsJsonError) {
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			this.showStatus(
				savedImplicitProjectTrust
					? "Reloaded keybindings, extensions, skills, prompts, themes, and context files; saved project trust"
					: "Reloaded keybindings, extensions, skills, prompts, themes, and context files",
			);
			dismissReloadBox(this.editor as Component);
			reloadBoxDismissed = true;
		} catch (error) {
			if (!reloadBoxDismissed) {
				dismissReloadBox(previousEditor as Component);
			}
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleExportCommand(outputPath?: string): Promise<void> {
		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = this.session.exportToJsonl(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			} else {
				const filePath = await exportSessionHtml(this.session, outputPath, {
					themeName: theme.name,
				});
				this.showStatus(`Session exported to: ${filePath}`);
			}
		} catch (error: unknown) {
			throw new Error(`Failed to export session: ${error instanceof Error ? error.message : String(error)}`, {
				cause: error,
			});
		}
	}

	private async handleImportCommand(inputPath: string): Promise<"edit" | undefined> {
		if (!inputPath) {
			throw new Error("Enter a session JSONL path");
		}
		const resolvedPath = resolvePath(inputPath);
		if (!fs.existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}
		if (!fs.statSync(resolvedPath).isFile()) {
			throw new Error(`Not a file: ${resolvedPath}`);
		}
		fs.accessSync(resolvedPath, fs.constants.R_OK);

		const confirmed = await this.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
		if (!confirmed) {
			this.showStatus("Import cancelled");
			return "edit";
		}

		try {
			this.clearStatusIndicator();
			const result = await this.runtimeHost.importFromJsonl(inputPath);
			if (result.cancelled) {
				this.showStatus("Import cancelled");
				return "edit";
			}
			this.showStatus(`Session imported from: ${inputPath}`);
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Import cancelled");
					return "edit";
				}
				const result = await this.runtimeHost.importFromJsonl(inputPath, selectedCwd);
				if (result.cancelled) {
					this.showStatus("Import cancelled");
					return "edit";
				}
				this.showStatus(`Session imported from: ${inputPath}`);
				return;
			}
			if (error instanceof SessionImportFileNotFoundError) {
				throw new Error(`Failed to import session: ${error.message}`, { cause: error });
			}
			await this.handleFatalRuntimeError("Failed to import session", error);
		}
	}

	private async handleCopyCommand(
		options: { flashConfirmation?: boolean; preferSelection?: boolean } = {},
	): Promise<void> {
		if (options.preferSelection && !this.renderer.getCopyOnSelect() && this.renderer.hasActiveSelection()) {
			await this.renderer.copyActiveSelectionToClipboard();
			return;
		}

		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			if (options.flashConfirmation) {
				this.renderer.flash("Copied!");
			} else {
				this.showStatus("Copied last agent message to clipboard");
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleNameCommand(name: string): void {
		name = name.trim();
		if (!name) {
			throw new Error("Enter a session name");
		}

		this.session.setSessionName(name);
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName !== name) {
			this.showWarning(`Session name was normalized from ${JSON.stringify(name)} to ${JSON.stringify(sessionName)}`);
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${sessionName ?? name}`), 1, 0));
		this.renderer.requestRender();
	}

	private handleSessionCommand(): void {
		const stats = this.session.getSessionStats();
		const sessionName = this.sessionManager.getSessionName();
		const entries = this.sessionManager.getEntries();
		const cacheWaste = computeCacheWaste(entries, this.session.modelRuntime);

		// Cost/token totals per provider/model actually used (e.g. OpenRouter `auto`
		// resolves to a concrete responseModel). Usage without model attribution is
		// grouped separately so the breakdown reconciles with the session total.
		const usageBreakdown = getUsageCostBreakdown(entries);

		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n`;
		info += `${theme.fg("dim", "Directory:")} ${this.sessionManager.getCwd()}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tools:")} ${stats.toolCalls} calls, ${stats.toolResults} results\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		// "Input" is the full prompt volume. With cache activity, split it into
		// cached (served from cache) vs uncached (everything else) - the only
		// provider-independent split. Cache writes, where reported, are a detail
		// of the uncached portion.
		const { input, cacheRead, cacheWrite } = stats.tokens;
		const promptTokens = input + cacheRead + cacheWrite;
		info += `${theme.fg("dim", "Input:")} ${promptTokens.toLocaleString()}\n`;
		if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
			const hitRate = theme.fg("dim", `(${((cacheRead / promptTokens) * 100).toFixed(1)}%)`);
			info += `  ${theme.fg("dim", "Cached:")} ${cacheRead.toLocaleString()} ${hitRate}\n`;
			const written =
				cacheWrite > 0 ? ` ${theme.fg("dim", `(${cacheWrite.toLocaleString()} written to cache)`)}` : "";
			info += `  ${theme.fg("dim", "Uncached:")} ${(input + cacheWrite).toLocaleString()}${written}\n`;
		}
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		const cacheWarmingStatus = this.session.cacheWarmingStatus;
		info += `\n${theme.bold("Cache Warming")}\n`;
		info += `${theme.fg("dim", "Mode:")} ${this.settingsManager.getCacheWarmingMode()}\n`;
		info += `${theme.fg("dim", "Status:")} ${cacheWarmingStatus ? formatCacheWarmingStatus(cacheWarmingStatus) : "Inactive (cache warming unavailable)"}\n`;
		const decision = cacheWarmingStatus?.decision;
		if (decision?.economicsAvailable) {
			info += `${theme.fg("dim", "Cache miss penalty:")} $${decision.missCost.toFixed(3)}\n`;
			info += `${theme.fg("dim", "Refresh cost:")} $${decision.warmCost.toFixed(3)}\n`;
		}

		if (stats.cost > 0 || cacheWaste.missedTokens > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} $${stats.cost.toFixed(3)}`;
			if (usageBreakdown.length > 1) {
				for (const entry of usageBreakdown) {
					info += `\n  ${theme.fg("dim", `${entry.key}:`)} $${entry.cost.toFixed(3)} ${theme.fg("dim", `(${formatTokens(entry.tokens)} tokens)`)}`;
				}
			}
			if (cacheWaste.missedTokens > 0) {
				const missLabel = cacheWaste.missCount === 1 ? "1 miss" : `${cacheWaste.missCount} misses`;
				const detail = `${cacheWaste.missedTokens.toLocaleString()} tokens, ${missLabel}`;
				info +=
					cacheWaste.missedCost >= 0.0001
						? `\n${theme.fg("dim", "Cache Re-billed:")} $${cacheWaste.missedCost.toFixed(3)} ${theme.fg("dim", `(${detail})`)}`
						: `\n${theme.fg("dim", "Cache Re-billed:")} ${detail}`;
			}
		}

		this.showReader("Session", info);
	}

	private handleChangelogCommand(): void {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
						.reverse()
						.map((e) => normalizeChangelogLinks(e.content, e))
						.join("\n\n")
				: "No changelog entries found.";

		this.showReader(`Changelog · Installed v${this.version}`, changelogMarkdown);
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppKeybinding): string {
		return keyDisplayText(action);
	}

	private showReader(
		title: string,
		content: string,
		rows?: readonly ReadingPanelRow[],
		onEdit?: () => Promise<string | undefined>,
	): void {
		const session = this.session;
		let close: () => void;
		const mount = () =>
			this.pageController.showSelector((done) => {
				close = done;
				return { component: panel, focus: panel };
			});
		const panel = new ReadingPanelComponent(
			title,
			content,
			() => close(),
			rows,
			onEdit
				? () => {
						void onEdit()
							.then((updated) => {
								if (this.session !== session) return;
								if (updated !== undefined) panel.setContent(updated);
								mount();
							})
							.catch((error: unknown) => {
								if (this.session !== session) return;
								this.showError(error instanceof Error ? error.message : String(error), "Could not edit file");
								mount();
							});
					}
				: undefined,
		);
		mount();
	}

	private handleHotkeysCommand(): void {
		const categories: Record<string, string> = {
			editor: "Editing",
			input: "Input",
			select: "Lists",
			altScreen: "Conversation",
			thinking: "Thinking",
			shell: "Shell",
			powerbar: "Powerbar",
			panel: "Panels",
			model: "Models",
			models: "Models",
			tools: "Details",
			session: "Sessions",
			tree: "Tree",
			message: "Messages",
			clipboard: "Clipboard",
		};
		const rows: ReadingPanelRow[] = [];
		for (const action of Object.keys(KEYBINDINGS) as Keybinding[]) {
			const keys = this.keybindings.getKeys(action);
			if (!keys.length) continue;
			rows.push({
				category: categories[action.split(".")[1]] ?? "General",
				label: KEYBINDINGS[action].description,
				value: keys.map(keycap).join(" / "),
			});
		}
		rows.sort((a, b) => a.category.localeCompare(b.category));
		for (const [key, shortcut] of this.session.extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig())) {
			rows.push({
				category: "Extensions",
				label: shortcut.description ?? shortcut.extensionPath,
				value: keycap(key),
			});
		}
		this.showReader("Hotkeys", "", rows);
	}

	private async handleClearCommand(): Promise<void> {
		this.clearStatusIndicator();
		try {
			const result = await this.runtimeHost.newSession();
			if (result.cancelled) {
				return;
			}

			this.renderer.requestRender();
		} catch (error: unknown) {
			if (this.session.isDisposed) await this.handleFatalRuntimeError("Failed to create session", error);
			else this.showError(error instanceof Error ? error.message : String(error), "Could not create session");
		}
	}

	private handleDebugCommand(): void {
		const width = this.renderer.terminal.columns;
		const height = this.renderer.terminal.rows;
		const allLines = this.renderer.render(width);

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		this.renderer.requestRender();
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		let eventResult: UserBashEventResult | undefined;
		try {
			eventResult = await extensionRunner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext,
				cwd: this.sessionManager.getCwd(),
			});
		} catch {
			// The extension runner already reported the error. Do not fall back to local execution.
			return;
		}

		// If extension returned a full result, use it directly
		this.dismissHome();
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(
				command,
				this.renderer,
				excludeFromContext,
				this.settingsManager.getToolPreviewLines(),
			);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.renderer.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(
			command,
			this.renderer,
			excludeFromContext,
			this.settingsManager.getToolPreviewLines(),
		);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.renderer.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.renderer.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.renderer.requestRender();
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		this.clearStatusIndicator();
		await this.session.compact(customInstructions);
	}

	stop(fullscreenExitOutput = this.settingsManager.getFullscreenExitOutput()): void {
		this.cancelActiveLogin();
		this.presentation.dispose();
		this.pageController.disposeActiveSelector();
		if (this.settingsManager.getShowTerminalProgress()) {
			this.renderer.terminal.setProgress(false);
		}
		this.clearStatusIndicator();
		this.themeController.disableAutoSync();
		this.clearExtensionTerminalInputListeners();
		this.footer.dispose();
		this.defaultEditor.dispose();
		this.composerPanel.dispose();
		this.helpPanel?.dispose();
		this.topBar.dispose();
		this.notification.dispose();
		this.chatContainer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.isInitialized) {
			this.stopInteractiveTui(fullscreenExitOutput);
			this.isInitialized = false;
		}
		this.unregisterSignalHandlers();
	}
}
