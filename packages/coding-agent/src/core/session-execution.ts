/** Coordinates one active conversation for the interactive, print, RPC, and SDK hosts. */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	AfterToolCallContext,
	AgentContext,
	AgentEvent,
	AgentMessage,
	AgentMessageCommit,
	AgentOptions,
	AgentState,
	AgentTool,
	AgentTurnContext,
	BeforeToolCallContext,
	PrepareNextTurnContext,
	PrepareRequestContext,
	ThinkingLevel,
} from "@candy/agent-core";
import { Agent, AgentInputs, runToolCall } from "@candy/agent-core";
import type {
	AssistantMessage,
	ImageContent,
	JsonObject,
	Model,
	ProviderHeaders,
	SystemMessage,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@candy/ai";
import {
	cleanupSessionResources,
	contentText,
	getCurrentSystemMessage,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
	type RetryCallbacks,
	retryDelayMs,
} from "@candy/ai";
import { calculateContextTokens, estimateContextTokens } from "@candy/ai/utils/estimate";
import { sleep } from "@candy/ai/utils/sleep";
import { loadQuickJSWasm } from "@candy/codemode";
import { getAgentDir, getCodemodeWasmPath, getCodemodeWorkerUrl } from "../config.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { processImage } from "../utils/image-process.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import type { CacheWarmer, CacheWarmingStatus } from "./cache-warmer.ts";
import {
	CODEMODE_ENABLED_ENTRY_TYPE,
	type CodemodeEnabledEntryData,
	createCodemodeToolDefinition,
	readCodemodeEnabled,
} from "./codemode-tool.ts";
import type { CommandInfo, CommandInvocation } from "./commands.ts";
import {
	type CompactionResult,
	collectEntriesForBranchSummary,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { CompactionCancelledError, CompactionOperation } from "./compaction-operation.ts";
import {
	type AgentActivityOutcome,
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type ReplacedSessionContext,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolInfo,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { McpRuntime } from "./mcp/runtime.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { ModelSelection } from "./model-selection.ts";
import { SessionBoundary } from "./session-boundary.ts";
import { SessionInputExecution } from "./session-input-execution.ts";
import { estimateProjectedContextTokens } from "./session-queries.ts";

export type { ModelMutationOptions } from "./model-selection.ts";

import { type PromptTemplate, parseCommandArgs, substituteArgs } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { ResourceOperations } from "./resource-operations.ts";
import { createSearchMcpToolsDefinition } from "./search-mcp-tools.ts";
import {
	type BranchSummaryEntry,
	type ContextEditEntry,
	getLatestCompactionEntry,
	type SessionEntry,
	type SessionHistory,
} from "./session-history.ts";
import { SessionTools } from "./session-tools.ts";
import type { CacheWarmingMode, SettingsManager } from "./settings-manager.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	diffSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "./system-prompt.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled" }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
export type AgentExecutionListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

// ============================================================================
// Types
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface SessionExecutionConfig {
	agentOptions: Omit<AgentOptions, "host" | "inputs">;
	sessionManager: SessionHistory;
	settingsManager: SettingsManager;
	cwd: string;
	agentDir?: string;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	mcp?: McpRuntime;
	/** Keeps the prompt cache entry of the last session request warm. */
	cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Explicit startup selection takes precedence over a saved codemode preference. */
	initialCodemodeSelection?: boolean;
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Runtime-scoped owner for provider resources. */
	resourceOwner?: object;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export type QueuedInputDisposition = "handled" | "queued";
export type PromptDisposition = QueuedInputDisposition | "started";

export interface QueuedInput {
	text: string;
	images?: ImageContent[];
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe how an accepted prompt was dispatched. Not called if the prompt is rejected. */
	preflightResult?: (disposition: PromptDisposition) => void;
}

/** Options for model/thinking mutations. */
/** Session statistics for the History details view. */
export type { SessionStats } from "./session-queries.ts";

// ============================================================================
// AgentSession Class
// ============================================================================

export class SessionExecution {
	private readonly _boundary: SessionBoundary;
	private readonly agent: Agent;
	readonly sessionManager: SessionHistory;
	readonly settingsManager: SettingsManager;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _unsubscribeAgentQueue?: () => void;
	private _unsubscribeSettings?: () => void;
	private _unsubscribeMcp?: () => void;
	private _mcpRefreshPending = false;
	private readonly _mcp?: McpRuntime;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _agentRunAbortRequested = false;
	private _promptAbortController: AbortController | undefined;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	private readonly _inputs = new AgentInputs();
	private readonly _inputExecution: SessionInputExecution;
	private readonly _resourceOwner: object;
	private _compactionOperation!: CompactionOperation;
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Context-only custom messages queued during a run, flushed once the current turn's tool results are in. */
	private _pendingCustomMessages: CustomMessage[] = [];

	// Compaction state
	private _drainingCompactionCommands = false;
	private _disposed = false;
	private _disposePromise?: Promise<void>;
	private _activeOperations = 0;
	private _operationWaiters: Array<() => void> = [];
	private _overflowRecoveryAttempted = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private readonly _pendingProviderRefreshes = new Set<string>();
	private _turnIndex = 0;
	private _lastAssistantMessage: AssistantMessage | undefined;
	private _lastAssistantEntryId: string | undefined;
	private _lastAssistantToolResultEntryIds: string[] = [];
	private _lastActivityOutcome: AgentActivityOutcome = "completed";
	private _isEmittingAgentSettled = false;
	private readonly _deferredSettledActions: Array<() => Promise<void>> = [];

	private _resourceLoader: ResourceLoader;
	private _resources!: ResourceOperations;
	private _customTools: ToolDefinition[];
	private _cwd: string;
	private _initialCodemodeSelection?: boolean;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;
	readonly selection: ModelSelection;
	private _cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;

	private readonly _tools: SessionTools;

	private _baseSystemPromptOptions!: NormalizedBuildSystemPromptOptions;
	/** Prompt options after before_agent_start mutations for the active run. */
	private _runSystemPromptOptions?: NormalizedBuildSystemPromptOptions;

	constructor(config: SessionExecutionConfig) {
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._resourceLoader = config.resourceLoader;
		this._resourceOwner = config.resourceOwner ?? {};
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._mcp = config.mcp;
		this._boundary = new SessionBoundary(
			this.sessionManager,
			() => [...this._inputs.peekQueuedMessages(), ...this._pendingCustomMessages],
			(entry) => this._emit({ type: "entry_appended", entry }),
		);

		this.agent = new Agent({
			...config.agentOptions,
			inputs: this._inputs,
			beforeToolCall: (context) => this._beforeToolCall(context),
			afterToolCall: (context) => this._afterToolCall(context),
			transformContext: (messages) => this._transformContext(messages),
			host: {
				messages: () => this.sessionManager.buildSessionProjection().messages.slice(),
				commit: (message) => this._finalizeAgentMessage(message),
				reset: () => this.sessionManager.resetLeaf(),
				prepareRequest: (request, signal) => this._prepareRequest(request, signal),
				prepareNextTurn: (turn) => this._prepareNextTurn(turn),
				finishTurn: (turn) => this._finishTurn(turn),
			},
		});
		this._inputExecution = new SessionInputExecution(this._inputs, () => this._emitQueueUpdate());
		this._unsubscribeAgentQueue = this._inputs.subscribeQueue(() => this._emitQueueUpdate());
		this.selection = new ModelSelection(this.agent, this._modelRuntime, this.sessionManager, this.settingsManager, {
			isDisposed: () => this._disposed,
			isBusy: () => this.isStreaming || this.isCompacting,
			onThinkingLevelChange: (level) => {
				this._emit({ type: "thinking_level_changed", level });
			},
		});
		this._cacheWarmer = config.cacheWarmer;
		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = (entry) => this._emit({ type: "entry_appended", entry });
		}
		this._initialCodemodeSelection = config.initialCodemodeSelection;
		this._tools = new SessionTools(config.allowedToolNames, config.excludedToolNames);
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		const session = this;
		this._compactionOperation = new CompactionOperation({
			agent: this.agent,
			get model() {
				return session.model;
			},
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			get thinkingLevel() {
				return session.thinkingLevel;
			},
			getSummarizationRequestAuth: (model, signal) => this._getSummarizationRequestAuth(model, signal),

			summarizationRetryCallbacks: (reason) => this._summarizationRetryCallbacks({ source: "compaction", reason }),
		});

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this.agent.transport = this.settingsManager.read("transport");
		this.syncQueueModesFromSettings();
		this._unsubscribeSettings = this.settingsManager.subscribe(({ fields }) => {
			if (fields.includes("transport")) this.agent.transport = this.settingsManager.read("transport");
			if (fields.includes("steeringMode") || fields.includes("followUpMode")) this.syncQueueModesFromSettings();
			if (fields.includes("cacheWarming")) this._cacheWarmer?.onModeChanged();
		});

		this._buildRuntime({
			activeToolNames: config.initialActiveToolNames
				? this._withCodemodeSelection(config.initialActiveToolNames)
				: undefined,
			includeAllExtensionTools: true,
		});
		if (this._initialCodemodeSelection === undefined) this._restoreToolsFromTranscript();
		this._resources = new ResourceOperations(this, { cwd: config.cwd, agentDir: config.agentDir ?? getAgentDir() });
		this._unsubscribeMcp = this._mcp?.subscribe(() => {
			if (this._disposed) return;
			if (!this.isIdle) this._mcpRefreshPending = true;
			else this._refreshToolRegistry();
		});
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	private async _getSummarizationRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		const result = await this._modelRuntime.getAuth(model, { signal });
		if (!result) throw new Error(formatNoApiKeyFoundMessage(model.provider));
		const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
		return {
			model: requestModel,
			apiKey: result.auth.apiKey,
			headers: withoutDeletedHeaders(result.auth.headers),
			env: result.env,
		};
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private async _beforeToolCall({ toolCall, args, parentToolCallId }: BeforeToolCallContext) {
		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		try {
			return await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				parentToolCallId,
				input: args as Record<string, unknown>,
			});
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	}

	private async _afterToolCall({ model, toolCall, args, result, isError, parentToolCallId }: AfterToolCallContext) {
		const runner = this._extensionRunner;
		const hookResult = runner.hasHandlers("tool_result")
			? await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					parentToolCallId,
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					structuredContent: result.structuredContent,
					isError,
					usage: result.usage,
				})
			: undefined;

		const content = hookResult?.content ?? result.content ?? [];
		// Runs after the extension hook so images injected or replaced by extensions are normalized too.
		const resizeOptions = model.inputLimits?.images?.resize;
		const normalizedContent = await normalizeToolResultImages(content, {
			autoResizeImages: this.settingsManager.read("auto-resize-images"),
			...(resizeOptions ? { resizeOptions } : {}),
		});

		if (!hookResult && normalizedContent === content) {
			return undefined;
		}

		return {
			content: normalizedContent,
			details: hookResult?.details,
			structuredContent: hookResult?.structuredContent,
			isError: hookResult?.isError ?? isError,
			usage: hookResult?.usage,
		};
	}

	private async _compactBeforeNextAssistantResponse(context: AgentContext): Promise<AgentContext> {
		const model = this.model;
		const settings = this.settingsManager.getCompactionSettings(model);
		const projection = this.sessionManager.buildSessionProjection();

		if (
			!model ||
			model.contextWindow <= 0 ||
			!shouldCompact(
				estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens,
				model.contextWindow,
				settings,
			)
		) {
			return { ...context, messages: projection.messages.slice() };
		}

		await this._runAutoCompaction("threshold", false);
		return { ...context, messages: this.sessionManager.buildSessionProjection().messages.slice() };
	}

	private async _prepareRequest(request: PrepareRequestContext, signal?: AbortSignal) {
		if (this._pendingProviderRefreshes.size > 0) {
			const providers = [...this._pendingProviderRefreshes];
			const refresh = await this._modelRuntime.refresh({ allowNetwork: false, providers, signal });
			if (refresh.aborted) signal?.throwIfAborted();
			const errors = [...refresh.errors.values()];
			if (errors.length > 0) throw new AggregateError(errors, "Failed to refresh registered extension providers");
			this._pendingProviderRefreshes.clear();
			this.selection.refreshFromRegistry();
		}
		const model = this.model;
		if (!model) throw new Error("No model selected. Select a model before sending a prompt.");
		const thinkingLevel = this.agent.state.thinkingLevel;
		const canonicalContext = {
			...request.context,
			messages: this.sessionManager.buildSessionProjection().messages.slice(),
			// Messages declare the provider-visible loadout; context.tools keeps executable implementations.
			tools: this.agent.state.tools.slice(),
		};
		return {
			context: canonicalContext,
			model: model,
			thinkingLevel: thinkingLevel,
		};
	}

	private async _dispatchTurnEndBoundary(
		message: AssistantMessage,
		toolResults: ToolResultMessage[],
		messageEntryId: string | undefined,
		toolResultEntryIds: readonly (string | undefined)[],
	): Promise<boolean> {
		this._lastActivityOutcome =
			message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
		if (!this._extensionRunner.hasHandlers("turn_end")) return false;
		if (!messageEntryId) {
			this._extensionRunner.emitError({
				extensionPath: "<boundary>",
				event: "turn_end",
				error: "turn_end could not resolve the persisted assistant entry ID",
			});
			return false;
		}
		const committedToolResultEntryIds = toolResultEntryIds.filter(
			(entryId): entryId is string => entryId !== undefined,
		);
		const boundary = await this._extensionRunner.emitBoundary(
			{
				type: "turn_end",
				turnIndex: this._turnIndex,
				message,
				toolResults,
				messageEntryId,
				toolResultEntryIds: committedToolResultEntryIds,
				outcome: this._lastActivityOutcome,
			},
			(entries) => {
				this._boundary.preview(entries);
				this._boundary.commit(entries);
				return this._boundary.preview([]);
			},
		);
		return this._lastActivityOutcome === "completed" && boundary.continue;
	}

	private async _finishTurn(turn: AgentTurnContext) {
		const extensionContinue = await this._dispatchTurnEndBoundary(
			turn.message,
			turn.toolResults,
			turn.messageEntry.entryId,
			turn.toolResultEntries.map((entry) => entry.entryId),
		);
		if (extensionContinue) return { action: "continue" as const };
		return undefined;
	}

	private async _prepareNextTurn(turn: PrepareNextTurnContext) {
		const context = await this._compactBeforeNextAssistantResponse({
			...turn.context,
			messages: this.sessionManager.buildSessionProjection().messages.slice(),
		});
		const nextContext = context;
		const runOptions = this._runSystemPromptOptions ?? this._baseSystemPromptOptions;
		const options = normalizeBuildSystemPromptOptions({
			...runOptions,
			selectedTools: this.getActiveToolNames(),
			toolSnippets: { ...this._baseSystemPromptOptions.toolSnippets, ...runOptions.toolSnippets },
			toolGuidelines: { ...this._baseSystemPromptOptions.toolGuidelines, ...runOptions.toolGuidelines },
		});
		const updateMessage = this._preparePromptAndToolLoadout(options, nextContext.messages);
		// Keep session.systemPrompt and ctx.getSystemPrompt() in step with what the provider sees.
		this._runSystemPromptOptions = options;

		return {
			context: {
				...nextContext,
				tools: this.agent.state.tools.slice(),
			},
			messages: updateMessage ? [updateMessage] : undefined,
			model: this.agent.state.model,
			thinkingLevel: this.agent.state.thinkingLevel,
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: this.getSteeringMessages(),
			followUp: this.getFollowUpMessages(),
		});
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (!this.isIdle || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private _trackOperation(): () => void {
		this._activeOperations++;
		let settled = false;
		return () => {
			if (settled) throw new Error("Operation settlement was recorded more than once");
			settled = true;
			this._activeOperations--;
			if (this._activeOperations === 0) {
				for (const resolve of this._operationWaiters.splice(0)) resolve();
			}
		};
	}

	private _waitForOperations(): Promise<void> {
		if (this._activeOperations === 0) return Promise.resolve();
		return new Promise((resolve) => this._operationWaiters.push(resolve));
	}

	private async _emitAgentSettled(): Promise<void> {
		this._cacheWarmer?.onAgentSettled();
		this._isAgentRunActive = false;
		if (this._mcpRefreshPending) {
			this._mcpRefreshPending = false;
			this._refreshToolRegistry();
		}
		this._isEmittingAgentSettled = true;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			this._isEmittingAgentSettled = false;
		}

		const deferred = this._deferredSettledActions.splice(0);
		if (deferred.length > 0) {
			try {
				for (const action of deferred) await action();
			} finally {
				this._resolveIdleWaitIfIdle();
			}
			return;
		}
		this._resolveIdleWaitIfIdle();
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
		}

		// Message finalization runs in Agent before state publication; this handler publishes only committed events.
		await this._emitExtensionEvent(event);

		if (event.type === "message_end") {
			if (event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				this._lastAssistantMessage = assistantMsg;
				this._lastAssistantEntryId = event.entryId;
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		// A turn ends after its assistant message and every tool result has been appended,
		// so this is the first point in the run where a context-only custom message can be
		// inserted without landing between a tool call and its result. Flushing after the
		// extension and listener dispatch above also picks up messages that turn_end
		// handlers queued.
		if (event.type === "turn_end") {
			this._lastAssistantEntryId = event.messageEntry.entryId;
			this._lastAssistantToolResultEntryIds = event.toolResultEntries.flatMap((entry) =>
				entry.entryId === undefined ? [] : [entry.entryId],
			);
			this._flushPendingCustomMessages();
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		if (this._agentRunAbortRequested) return false;
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	private _omitRecoveryAttempt(entryIds: readonly string[]): void {
		for (const targetId of entryIds) {
			const editId = this.sessionManager.appendContextEdit(targetId, null);
			const entry = this.sessionManager.getEntry(editId);
			if (entry) this._emit({ type: "entry_appended", entry });
		}
	}

	private _findLastProjectedAssistant(): AgentMessageCommit | undefined {
		const entries = this.sessionManager.buildSessionProjection().entries;
		for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex--) {
			const entry = entries[entryIndex];
			for (let messageIndex = entry.messages.length - 1; messageIndex >= 0; messageIndex--) {
				const message = entry.messages[messageIndex];
				if (message.role === "assistant") return { message, entryId: entry.sourceEntry.id };
			}
		}
		return undefined;
	}

	private async _finalizeAgentMessage(message: AgentMessage): Promise<AgentMessageCommit> {
		if (message.role === "branchSummary" || message.role === "compactionSummary")
			throw new Error(`Cannot commit projected ${message.role} messages`);
		const entryId =
			message.role === "custom"
				? this.sessionManager.appendCustomMessageEntry(
						message.customType,
						message.content,
						message.display,
						message.details,
					)
				: this.sessionManager.appendMessage(message);
		return { message, entryId };
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			await this._extensionRunner.emit({ type: "turn_start", turnIndex: this._turnIndex, timestamp: Date.now() });
		} else if (event.type === "turn_end") {
			this._turnIndex++;
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	subscribeExecution(listener: AgentExecutionListener): () => void {
		return this.agent.subscribe(listener);
	}

	/** Disconnect from agent events during disposal. */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): Promise<void> {
		if (this._disposePromise) return this._disposePromise;
		this._disposed = true;
		this._disposePromise = this._disposeResources();
		return this._disposePromise;
	}

	private async _disposeResources(): Promise<void> {
		this._inputExecution.rejectDeferred(new Error("Session was disposed before the queued input could run"));
		const errors: unknown[] = [];
		const release = async (operation: () => void | Promise<void>): Promise<void> => {
			try {
				await operation();
			} catch (error) {
				errors.push(error);
			}
		};
		await Promise.all([
			release(() => this.abortRetry()),
			release(() => this.abortCompaction()),
			release(() => this.abortBranchSummary()),
			release(() => this.abortBash()),
			release(() => this.agent.abort()),
		]);
		await Promise.all([release(() => this.agent.waitForIdle()), release(() => this._waitForOperations())]);
		await release(() =>
			this._extensionRunner.invalidate(
				"This extension ctx is stale after session replacement or reload. Do not use a captured candy or command ctx after ctx.newSession(), ctx.fork(), ctx.clone(), ctx.switchSession(), or ctx.reload(). For newSession, fork, clone, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
			),
		);
		await release(() => this._disconnectFromAgent());
		this._unsubscribeAgentQueue?.();
		this._unsubscribeAgentQueue = undefined;
		this._unsubscribeSettings?.();
		this._unsubscribeSettings = undefined;
		this._unsubscribeMcp?.();
		this._unsubscribeMcp = undefined;
		this._eventListeners = [];
		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = undefined;
			await release(() => this._cacheWarmer?.cancel());
		}
		await release(() => cleanupSessionResources(this._resourceOwner));
		if (errors.length > 0) throw new AggregateError(errors, "Failed to dispose agent session");
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current cache-warming state and the policy inputs that produced it. */
	get cacheWarmingStatus(): CacheWarmingStatus | undefined {
		return this._cacheWarmer?.status;
	}

	/** Persist the cache-warming mode, then reconcile active warming. */
	async setCacheWarmingMode(mode: CacheWarmingMode): Promise<void> {
		await this.settingsManager.commitSetting("global", "cacheWarming", mode);
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.selection.model;
	}

	get isDisposed(): boolean {
		return this._disposed;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.selection.thinkingLevel;
	}

	/** Whether the session is processing prompt preflight, an agent run, or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive || this._promptAbortController !== undefined;
	}

	/** Whether the session has no active agent run, compaction, branch summary, retry, or queued continuation. */
	get isIdle(): boolean {
		return !this.isStreaming && !this.isCompacting;
	}

	/** Current effective system prompt, including changes not yet sent to the model. */
	get systemPrompt(): string {
		return buildSystemPrompt(this._runSystemPromptOptions ?? this._baseSystemPromptOptions);
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this._tools.getActiveToolNames();
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return this._tools.getAllDefinitions();
	}

	private async _hasProviderAuth(providerId: string): Promise<boolean> {
		const availability = await this._modelRuntime.getAvailability(providerId);
		return availability.providers.find((provider) => provider.providerId === providerId)?.auth !== undefined;
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._tools.getDefinition(name);
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		if (!this.isIdle) throw new Error("Wait for the current response or compaction to finish");
		this._setActiveToolsByName(toolNames);
	}

	private _setActiveToolsByName(toolNames: string[]): void {
		const previouslyEnabled = this.getActiveToolNames().includes("codemode");
		const savedSelection = readCodemodeEnabled(this.sessionManager.getBranch());
		const previousSelection = this._initialCodemodeSelection ?? savedSelection ?? this._defaultCodemodeEnabled();
		this._tools.setActiveTools(toolNames, true);
		const activeToolNames = this._tools.getActiveToolNames();
		const enabled = toolNames.includes("codemode") || activeToolNames.includes("codemode");
		if (enabled !== previouslyEnabled || enabled !== previousSelection) {
			if (enabled !== savedSelection) {
				const data: CodemodeEnabledEntryData = { enabled };
				const id = this.sessionManager.appendCustomEntry(CODEMODE_ENABLED_ENTRY_TYPE, data);
				const entry = this.sessionManager.getEntry(id);
				if (entry) this._emit({ type: "entry_appended", entry });
			}
			this._initialCodemodeSelection = undefined;
			this._tools.setCodemodeDisabled(!enabled);
		}
		this._applyActiveToolsByName(activeToolNames);
	}

	private _applyActiveToolsByName(toolNames: string[]): void {
		this._tools.setActiveTools(toolNames);
		this.agent.state.tools = this._tools.getDirectTools();
		this._rebuildSystemPrompt(this.agent.state.tools.map((tool) => tool.name));
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return this._compactionOperation.isRunning || this._branchSummaryAbortController !== undefined;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this._inputs.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this._inputs.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _rebuildSystemPrompt(toolNames: string[]): void {
		const validToolNames = toolNames.filter((name) => this._tools.getTool(name) !== undefined);
		const toolSnippets: Record<string, string> = {};
		for (const name of this._tools.getToolNames()) {
			const snippet = this._tools.getPromptSnippets().get(name);
			if (snippet) toolSnippets[name] = snippet;
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt = loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : "";
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			toolGuidelines: Object.fromEntries(this._tools.getPromptGuidelines()),
		});
	}

	/**
	 * Apply a prompt and tool loadout for the next request. Sets the executable tools and
	 * returns a system message patching the prompt sections the model currently has (replayed
	 * from `messages`), or undefined when the prompt is unchanged. Tool changes are declared by
	 * the agent loop before the request.
	 *
	 * A forced prompt does not affect the transcript: the structured sections are still diffed
	 * and persisted, and the forced text is projected onto the request by
	 * the request context projection.
	 */
	private _preparePromptAndToolLoadout(
		options: NormalizedBuildSystemPromptOptions,
		messages: AgentMessage[] = this.agent.state.messages,
	): SystemMessage | undefined {
		options.selectedTools = [...new Set(options.selectedTools)].filter((name) => {
			const tool = this._tools.getTool(name);
			return tool && (!tool.exposure || tool.exposure === "direct");
		});
		this._tools.setActiveTools([
			...options.selectedTools,
			...this._tools.getActiveToolNames().filter((name) => {
				const exposure = this._tools.getTool(name)?.exposure;
				return exposure && exposure !== "direct";
			}),
		]);
		this.agent.state.tools = this._tools.getDirectTools();
		options.selectedTools = this.agent.state.tools.map((tool) => tool.name);
		const sections = diffSystemPromptSections(
			getCurrentSystemMessage(messages)?.sections ?? {},
			buildSystemPromptSections(options),
		);
		return sections ? { role: "system", content: "", sections, timestamp: Date.now() } : undefined;
	}

	/**
	 * Send a forced prompt as the provider's leading system prompt without recording it.
	 *
	 * A `before_agent_start` handler that returns `systemPrompt` needs that exact text at the
	 * head of the request; a mid-conversation system message would leave the original prompt
	 * in place. The forced text is a rendering of the current prompt, so the transcript keeps
	 * its structured sections and the request is projected instead: the system messages
	 * collapse into one head holding the forced text and the current tools. Runs after the
	 * `context` extension handlers.
	 */
	private async _transformContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const transformed = await this._extensionRunner.emitContext(messages);
		const forced = this._runSystemPromptOptions?.forceSystemPrompt;
		if (forced === undefined) return transformed;
		const current = getCurrentSystemMessage(transformed);
		const head: SystemMessage = {
			role: "system",
			content: forced,
			...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
			timestamp: current?.timestamp ?? Date.now(),
		};
		return [head, ...transformed.filter((message) => message.role !== "system")];
	}

	private _defaultCodemodeEnabled(): boolean {
		return this._tools.getCodemodeTools(this._tools.getToolNames()).length > 0;
	}

	private _withCodemodeSelection(toolNames: string[]): string[] {
		const selection = this._initialCodemodeSelection ?? readCodemodeEnabled(this.sessionManager.getBranch());
		const disabled = this._initialCodemodeSelection === undefined && selection === false;
		this._tools.setCodemodeDisabled(disabled);
		const enabled = selection ?? this._defaultCodemodeEnabled();
		const names = toolNames.filter((name) => name !== "codemode");
		if (enabled || (!disabled && this._tools.getCodemodeTools(names).length > 0)) {
			names.push("codemode");
		}
		return names;
	}

	/** Restore the transcript's tool loadout and the current branch's codemode selection. */
	private _restoreToolsFromTranscript(): void {
		const current = getCurrentSystemMessage(this.sessionManager.buildSessionContext().messages);
		if (!current) {
			this._applyActiveToolsByName(this._withCodemodeSelection(this.getActiveToolNames()));
			return;
		}
		const toolNames = (current.toolsAdded ?? [])
			.map((tool) => tool.name)
			.filter((name) => this._tools.getTool(name) !== undefined);
		this._applyActiveToolsByName(
			this._withCodemodeSelection([
				...toolNames,
				...this._tools.getActiveToolNames().filter((name) => this._tools.getTool(name)?.exposure === "codemode"),
			]),
		);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		if (this.isStreaming) throw new Error("Agent is already processing");
		this._agentRunAbortRequested = false;
		this._isAgentRunActive = true;
		try {
			await this.agent.prompt(messages);
			while (!this._agentRunAbortRequested) {
				if (await this._handlePostAgentRun()) {
					if (this._agentRunAbortRequested) break;
					await this.agent.continue();
					continue;
				}
				break;
			}
		} finally {
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			this._runSystemPromptOptions = undefined;
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();
			await this._emitAgentSettled();
		}
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const message = this._lastAssistantMessage;
		const assistantEntryId = this._lastAssistantEntryId;
		const toolResultEntryIds = this._lastAssistantToolResultEntryIds;
		this._lastAssistantMessage = undefined;
		this._lastAssistantEntryId = undefined;
		this._lastAssistantToolResultEntryIds = [];
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}
		if (!message) return this._inputs.hasQueuedMessages();

		if (this._isRetryableError(message) && (await this._prepareRetry(message, assistantEntryId))) {
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			return !this._agentRunAbortRequested;
		}
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}

		if (message.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: message.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(message, true, assistantEntryId, toolResultEntryIds)) {
			return !this._agentRunAbortRequested;
		}

		// The low-level loop drains both queues before agent_end. Messages queued by
		// agent_end handlers require a fresh run before pre-settlement handlers fire.
		return !this._agentRunAbortRequested && this._inputs.hasQueuedMessages();
	}

	private async _runInputHandlers(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<{ text: string; images: ImageContent[] | undefined } | undefined> {
		if (!this._extensionRunner.hasHandlers("input")) {
			return { text, images };
		}

		const inputResult = await this._extensionRunner.emitInput(text, images, source, streamingBehavior);
		if (inputResult.action === "handled") {
			return undefined;
		}
		if (inputResult.action === "transform") {
			return { text: inputResult.text, images: inputResult.images ?? images };
		}
		return { text, images };
	}

	private async _normalizePromptImages(
		images: ImageContent[] | undefined,
	): Promise<{ images: ImageContent[]; hints: string[] }> {
		if (!images) return { images: [], hints: [] };

		const normalizedImages: ImageContent[] = [];
		const hints: string[] = [];
		for (const image of images) {
			const processed = await processImage(Buffer.from(image.data, "base64"), image.mimeType, {
				autoResizeImages: this.settingsManager.read("auto-resize-images"),
				resizeOptions: this.model?.inputLimits?.images?.resize,
			});
			if (!processed.ok) {
				hints.push(processed.message);
				continue;
			}
			normalizedImages.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
			hints.push(...processed.hints);
		}
		return { images: normalizedImages, hints };
	}

	/**
	 * Send a prompt to the agent.
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		if (this._disposed) throw new Error("Session was disposed before the prompt could run");
		if (this._isEmittingAgentSettled) {
			this._deferredSettledActions.push(async () => await this.prompt(text, options));
			return;
		}
		const preflightResult = options?.preflightResult;

		if (this._compactionOperation.isRunning || (this._branchSummaryAbortController && !this.isStreaming)) {
			if (options?.source === "rpc") throw new Error("Cannot submit an RPC prompt while compaction is in progress");
			preflightResult?.("queued");
			return this._inputExecution.deferDuringCompaction(text, options?.streamingBehavior ?? "followUp", options);
		}

		let abortController: AbortController | undefined;
		const wasStreaming = this.isStreaming;
		if (!wasStreaming) {
			// Reserve the prompt before hooks/authentication yield, so only its owner can start a run.
			abortController = new AbortController();
			this._promptAbortController = abortController;
		}
		try {
			// Emit input event for extension interception.
			const processedInput = await this._runInputHandlers(
				text,
				options?.images,
				options?.source ?? "interactive",
				wasStreaming ? options?.streamingBehavior : undefined,
			);
			if (this._disposed) throw new Error("Session was disposed before the prompt could run");
			if (!processedInput) {
				preflightResult?.("handled");
				return;
			}
			abortController?.signal.throwIfAborted();
			const { text: currentText, images: currentImages } = processedInput;

			// If streaming, queue via steer() or followUp() based on option
			if (
				this._isAgentRunActive ||
				(this._promptAbortController && this._promptAbortController !== abortController)
			) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					this._inputExecution.queue("followUp", currentText, currentImages);
				} else {
					this._inputExecution.queue("steer", currentText, currentImages);
				}
				preflightResult?.("queued");
				return;
			}

			if (!abortController) {
				abortController = new AbortController();
				this._promptAbortController = abortController;
			}

			// Flush any pending bash and custom messages before the new prompt
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await this._hasProviderAuth(this.model.provider));
			abortController.signal.throwIfAborted();
			if (!hasConfiguredAuth) {
				const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Open Sources to re-authenticate ${this.model.provider}.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Check if we need to compact before sending (catches aborted responses).
			// The user's new prompt is sent below, so do not call agent.continue() here.
			const lastAssistant = this._findLastProjectedAssistant();
			if (lastAssistant?.message.role === "assistant") {
				await this._checkCompaction(lastAssistant.message as AssistantMessage, false, lastAssistant.entryId);
			}

			abortController.signal.throwIfAborted();

			// Emit before_agent_start before normalizing images so extension-driven model
			// selection determines the resize profile used for the request and history.
			const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools;
			const result = await this._extensionRunner.emitBeforeAgentStart(
				currentText,
				currentImages,
				this._baseSystemPromptOptions,
			);
			abortController.signal.throwIfAborted();
			// Handlers may edit event.systemPromptOptions.selectedTools or call setActiveTools(),
			// which updates the live loadout instead. An explicit edit wins; otherwise the live
			// loadout is authoritative, so a setActiveTools() call is not undone here.
			const handlerEditedTools =
				result.systemPromptOptions.selectedTools.length !== selectedToolsBefore.length ||
				result.systemPromptOptions.selectedTools.some((name, index) => name !== selectedToolsBefore[index]);
			if (!handlerEditedTools) result.systemPromptOptions.selectedTools = this.getActiveToolNames();

			const normalized = await this._normalizePromptImages(currentImages);
			abortController.signal.throwIfAborted();
			const userText =
				normalized.hints.length > 0 ? `${currentText}\n\n${normalized.hints.join("\n")}` : currentText;

			// Build messages only after hooks and image normalization have completed.
			const messages: AgentMessage[] = [];
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: userText }];
			userContent.push(...normalized.images);
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			for (const msg of result.messages) {
				if (typeof msg.content !== "string" && !Array.isArray(msg.content)) {
					throw new Error(`Extension custom message "${msg.customType}" must contain text or content parts`);
				}
				messages.push({
					role: "custom",
					customType: msg.customType,
					content: msg.content,
					display: msg.display,
					details: msg.details,
					timestamp: Date.now(),
				});
			}
			const updateMessage = this._preparePromptAndToolLoadout(result.systemPromptOptions);
			this._runSystemPromptOptions = result.systemPromptOptions;
			if (updateMessage) messages.unshift(updateMessage);

			if (this._disposed) throw new Error("Session was disposed before the prompt could run");
			preflightResult?.("started");
			abortController.signal.throwIfAborted();
			this._promptAbortController = undefined;
			await this._runAgentPrompt(messages);
		} finally {
			if (abortController && this._promptAbortController === abortController) {
				this._promptAbortController = undefined;
				this._resolveIdleWaitIfIdle();
			}
		}
	}

	getCommands(): CommandInfo[] {
		const extensions: CommandInfo[] = this._extensionRunner.getRegisteredCommands().map((command) => ({
			source: "extension",
			name: command.invocationName,
			description: command.description,
			sourceInfo: command.sourceInfo,
		}));
		const prompts: CommandInfo[] = this.promptTemplates.map((template) => ({
			source: "prompt",
			name: template.name,
			description: template.description,
			argumentHint: template.argumentHint,
			sourceInfo: template.sourceInfo,
		}));
		const skills: CommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
			source: "skill",
			name: skill.name,
			description: skill.description,
			sourceInfo: skill.sourceInfo,
		}));
		return [...extensions, ...prompts, ...skills];
	}

	async executeCommand(invocation: CommandInvocation, options?: PromptOptions): Promise<void> {
		if (this._disposed) throw new Error("Session was disposed before the command could run");
		const { source, name, args } = invocation;
		if (source === "extension") {
			const command = this._extensionRunner.getCommand(name);
			if (!command) throw new Error(`Unknown extension command: ${name}`);
			try {
				await command.handler(args, this._extensionRunner.createCommandContext());
			} catch (error) {
				this._extensionRunner.emitError({
					extensionPath: command.sourceInfo.path,
					event: "command",
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
			options?.preflightResult?.("handled");
			return;
		}
		let text: string;
		if (source === "prompt") {
			const template = this.promptTemplates.find((item) => item.name === name);
			if (!template) throw new Error(`Unknown prompt command: ${name}`);
			text = substituteArgs(template.content, parseCommandArgs(args));
		} else {
			if (source !== "skill") throw new Error(`Unknown command source: ${source}`);
			const skill = this.resourceLoader.getSkills().skills.find((item) => item.name === name);
			if (!skill) throw new Error(`Unknown skill command: ${name}`);
			const body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			text = args.trim() ? `${skillBlock}\n\n${args.trim()}` : skillBlock;
		}
		await this.prompt(text, {
			...options,
			streamingBehavior: options?.streamingBehavior ?? (this.isCompacting ? "followUp" : undefined),
		});
	}

	private async _drainPendingCompactionInputs(): Promise<void> {
		if (this._drainingCompactionCommands) return;
		this._drainingCompactionCommands = true;
		try {
			while (
				!this._disposed &&
				!this._compactionOperation.isRunning &&
				!this._branchSummaryAbortController &&
				this._inputExecution.hasDeferred
			) {
				const item = this._inputExecution.takeDeferred()!;
				try {
					await this.prompt(item.text, {
						...item.options,
						streamingBehavior: item.mode,
						preflightResult: undefined,
					});
					item.resolve();
				} catch (error) {
					item.reject(error);
				}
			}
		} finally {
			this._drainingCompactionCommands = false;
		}
	}

	private async _queueUserInput(
		text: string,
		images: ImageContent[] | undefined,
		behavior: "steer" | "followUp",
		source: InputSource,
	): Promise<QueuedInputDisposition> {
		const processedInput = await this._runInputHandlers(
			text,
			images,
			source,
			this.isStreaming ? behavior : undefined,
		);
		if (!processedInput) return "handled";

		this._inputExecution.queue(behavior, processedInput.text, processedInput.images);
		return "queued";
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 */
	async steer(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return this._queueUserInput(text, images, "steer", options?.source ?? "interactive");
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 */
	async followUp(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return this._queueUserInput(text, images, "followUp", options?.source ?? "interactive");
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles four cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Streaming + triggerTurn false: appended to state/session once the current turn ends
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		if (typeof message.content !== "string" && !Array.isArray(message.content)) {
			throw new Error(`Custom message "${message.customType}" must contain text or content parts`);
		}
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming && options?.triggerTurn !== false) {
			if (options?.deliverAs === "followUp") {
				this._inputs.followUp(appMessage, { text: contentText(appMessage.content) });
			} else {
				this._inputs.steer(appMessage, { text: contentText(appMessage.content) });
			}
			this._emitQueueUpdate();
		} else if (options?.triggerTurn) {
			if (this._isEmittingAgentSettled) {
				this._deferredSettledActions.push(async () => await this._runAgentPrompt(appMessage));
				return;
			}
			await this._runAgentPrompt(appMessage);
		} else if (this.isStreaming) {
			// Appending now would put the message between an assistant tool call and its
			// result, which providers that validate message order reject on replay. Defer
			// to the end of the turn. Nothing is emitted yet: message events must not
			// describe messages the session tree does not contain.
			this._pendingCustomMessages.push(appMessage);
		} else {
			this._appendCustomMessage(appMessage);
		}
	}

	private _appendCustomMessage(appMessage: CustomMessage): void {
		this.sessionManager.appendCustomMessageEntry(
			appMessage.customType,
			appMessage.content,
			appMessage.display,
			appMessage.details,
		);
		this._emit({ type: "message_start", message: appMessage });
		this._emit({ type: "message_end", message: appMessage });
	}

	/**
	 * Append custom messages queued while the agent was running.
	 * Called once the current turn's tool results are in agent state and session history.
	 */
	private _flushPendingCustomMessages(): void {
		if (this._pendingCustomMessages.length === 0) return;

		const pending = this._pendingCustomMessages;
		this._pendingCustomMessages = [];
		for (const appMessage of pending) {
			this._appendCustomMessage(appMessage);
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this.prompt(text, {
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Withdraw queued inputs with their attachments.
	 */
	clearQueue(): { steering: QueuedInput[]; followUp: QueuedInput[] } {
		return this._inputExecution.withdraw();
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._inputExecution.count;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._inputExecution.getTexts("steer");
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._inputExecution.getTexts("followUp");
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	get resources(): ResourceOperations {
		return this._resources;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this._promptAbortController?.abort();
		this._promptAbortController = undefined;
		this._resolveIdleWaitIfIdle();
		if (this._isAgentRunActive) {
			this._agentRunAbortRequested = true;
		}
		this.abortRetry();
		this.abortCompaction();
		this.abortBranchSummary();
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this._inputs.steeringMode = this.settingsManager.read("steering-mode");
		this._inputs.followUpMode = this.settingsManager.read("follow-up-mode");
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.settingsManager.commitSetting("global", "steeringMode", mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.settingsManager.commitSetting("global", "followUpMode", mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	private _clearManualCompactionState(): void {
		this._compactionOperation.finish("manual");
		this._resolveIdleWaitIfIdle();
	}

	/**
	 * Manually compact the session context.
	 *
	 * This is the manual entry point used by History, RPC, and extensions. It is
	 * separate from automatic threshold/overflow compaction, which enters through
	 * `_checkCompaction()` and `_runAutoCompaction()`. Both paths use CompactionOperation
	 * to prepare, summarize and commit the new projection.
	 *
	 * Aborts the current agent operation first. Manual compaction never retries or
	 * continues the interrupted agent turn.
	 *
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		await this.abort();
		const controller = this._compactionOperation.start("manual");
		const settleOperation = this._trackOperation();
		this._emit({ type: "compaction_start", reason: "manual" });

		try {
			if (!this.model) throw new Error(formatNoModelSelectedMessage());
			const completed = await this._compactionOperation.run({
				reason: "manual",
				customInstructions,
				willRetry: false,
				signal: controller.signal,
				allowEmptyPreparation: false,
			});
			if (!completed) throw new Error("Nothing to compact (session too small)");
			const compactionResult = completed.result;
			// compaction_end listeners may submit queued prompts, so expose idle state before notifying them.
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			void this._drainPendingCompactionInputs();
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = controller.signal.aborted || error instanceof CompactionCancelledError;
			const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage,
			});
			void this._drainPendingCompactionInputs();
			if (controller.signal.aborted && !(error instanceof CompactionCancelledError)) {
				throw new CompactionCancelledError();
			}
			throw error;
		} finally {
			this._clearManualCompactionState();
			settleOperation();
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionOperation.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Dispatch automatic compaction after `agent_end` or before prompt submission.
	 * Manual compaction does not call this method; it enters through `compact()`.
	 *
	 * Automatic cases:
	 * 1. Overflow with retry: a context-overflow error or recoverable length stop;
	 *    remove the failed assistant message, compact, and retry the turn once.
	 * 2. Overflow without retry: a successful response exceeded the configured
	 *    context window; compact but preserve the completed response.
	 * 3. Threshold without retry: valid or estimated context usage crossed the
	 *    configured threshold; compact without retrying the completed response.
	 *
	 * Each case calls `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, that method calls the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @returns Whether the post-run loop should call `agent.continue()` for overflow recovery or queued messages
	 */
	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		assistantEntryId: string | undefined = undefined,
		toolResultEntryIds: readonly string[] = [],
	): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings(this.model);
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Automatic cases 1 and 2: context overflow.
		// A length stop is recoverable when output ended below the model's original desired limit,
		// independent of the configured context size or any context-clamped provider request limit.
		const currentProjection = this.sessionManager.buildSessionProjection();
		const assistantIsProjected =
			assistantEntryId !== undefined &&
			currentProjection.entries.some(
				(entry) =>
					entry.sourceEntry.id === assistantEntryId &&
					entry.messages.some((message) => message.role === "assistant"),
			);
		const branch = this.sessionManager.getBranch();
		const assistantIndex = assistantEntryId ? branch.findIndex((entry) => entry.id === assistantEntryId) : -1;
		const entriesAfterAssistant = assistantIndex >= 0 ? branch.slice(assistantIndex + 1) : [];
		const hasPostAssistantContextEdit = entriesAfterAssistant.some((entry) => entry.type === "context_edit");
		const latestAssistantEdit = entriesAfterAssistant
			.filter(
				(entry): entry is ContextEditEntry => entry.type === "context_edit" && entry.targetId === assistantEntryId,
			)
			.at(-1);
		const assistantRetainedForExplicitRecovery =
			assistantEntryId !== undefined &&
			!entriesAfterAssistant.some((entry) => entry.type === "compaction") &&
			latestAssistantEdit?.replacement !== null;
		const assistantUsageMatchesProjection = assistantIsProjected && !hasPostAssistantContextEdit;
		const explicitOverflow = assistantMessage.stopReason === "error" && isContextOverflow(assistantMessage);
		const contextOverflow =
			sameModel &&
			((explicitOverflow && assistantRetainedForExplicitRecovery) ||
				(assistantUsageMatchesProjection && isContextOverflow(assistantMessage, contextWindow)));
		const recoverableLength =
			sameModel &&
			assistantEntryId !== undefined &&
			assistantIsProjected &&
			isRecoverableLength(assistantMessage, this.model?.maxTokens ?? 0);
		if (contextOverflow || recoverableLength) {
			const willRetry = assistantMessage.stopReason !== "stop";

			// Case 2: the response completed successfully. Compact, but do not retry because
			// agent.continue() cannot continue from a completed assistant response.
			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				const errorMessage = contextOverflow
					? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
					: "Truncated response recovery failed after one compact-and-retry attempt.";
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage,
				});
				return false;
			}

			// Persistently omit the selected final attempt before post-run recovery compaction.
			this._overflowRecoveryAttempted = true;
			if (assistantEntryId === undefined) return false;
			this._omitRecoveryAttempt([assistantEntryId, ...toolResultEntryIds]);
			return await this._runAutoCompaction("overflow", willRetry);
		}

		// Case 3: threshold compaction without retry.
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		const projection = currentProjection;
		const hasContextEdits = projection.entries.some((entry) => entry.sourceEntry.type === "context_edit");
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (hasContextEdits) {
			contextTokens = estimateProjectedContextTokens(projection, branch).tokens;
		} else if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			// Without provider usage, estimate.tokens is the pure message-size estimate.
			// Only usage-backed estimates need the stale pre-compaction check.
			if (estimate.lastUsageIndex !== null) {
				// Verify the usage source is post-compaction. Kept pre-compaction messages
				// have stale usage reflecting the old (larger) context and would falsely
				// trigger compaction right after one just finished.
				const usageMsg = messages[estimate.lastUsageIndex];
				if (
					compactionEntry &&
					usageMsg.role === "assistant" &&
					(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
				) {
					return false;
				}
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Execute threshold or overflow compaction. Manual compaction uses
	 * `AgentSession.compact()` instead. Both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts` after preparation and extension
	 * interception.
	 *
	 * @param reason Automatic trigger selected by `_checkCompaction()`
	 * @param willRetry Whether to continue the interrupted turn after overflow compaction
	 * @returns Whether the post-run loop should call `agent.continue()`
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const settleOperation = this._trackOperation();
		const model = this.model;
		const settings = this.settingsManager.getCompactionSettings(model);
		let abortController: AbortController | undefined;
		let started = false;
		let cancelledByExtension = false;

		try {
			if (!model) {
				return false;
			}

			const pathEntries = this.sessionManager.getBranch();
			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				return false;
			}

			abortController = new AbortController();
			abortController = this._compactionOperation.start("automatic");
			started = true;
			this._emit({ type: "compaction_start", reason });
			abortController.signal.throwIfAborted();

			const completed = await this._compactionOperation.run({
				reason,
				willRetry,
				signal: abortController.signal,
				allowEmptyPreparation: true,
			});
			if (!completed) return false;
			const result = completed.result;
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) return true;

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this._inputs.hasQueuedMessages();
		} catch (error) {
			const message = error instanceof Error ? error.message : "compaction failed";
			cancelledByExtension = error instanceof CompactionCancelledError;
			const aborted = abortController?.signal.aborted === true || cancelledByExtension;
			if (started) {
				const errorMessage = aborted
					? undefined
					: reason === "overflow"
						? `Context overflow recovery failed: ${message}`
						: `Auto-compaction failed: ${message}`;
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted,
					willRetry: false,
					errorMessage,
				});
			}
			return false;
		} finally {
			this._compactionOperation.finish("automatic", abortController);
			await this._drainPendingCompactionInputs();
			this._resolveIdleWaitIfIdle();
			settleOperation();
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	async setAutoCompactionEnabled(enabled: boolean): Promise<void> {
		await this.settingsManager.commitNestedSetting("global", "compaction", "enabled", enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.read("autocompact");
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._rebuildSystemPrompt(this.getActiveToolNames());
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _bindExtensionCore(runner: ExtensionRunner): boolean {
		return runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this._setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands: () => this.getCommands(),
				setModel: async (model) => {
					if (!(await this._hasProviderAuth(model.provider))) return false;
					await this.selection.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.selection.setThinkingLevel(level),
			},
			{
				getHistory: () => this.sessionManager,
				getModel: () => this.model,
				getResources: () => this._resources,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._pendingProviderRefreshes.add(provider.id);
					this.selection.refreshFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this.selection.refreshFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		this._tools.setRuntimeDefinitions(this._mcp?.getTools() ?? []);
		const previousActiveToolNames = this.getActiveToolNames();
		const activeToolNames = this._tools.refresh(
			this._extensionRunner,
			this._customTools,
			previousActiveToolNames,
			options,
		);
		this._applyActiveToolsByName(activeToolNames);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): boolean {
		const autoResizeImages = this.settingsManager.read("auto-resize-images");
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions: Record<string, ToolDefinition> = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
				});

		const wasmPath = getCodemodeWasmPath();
		baseToolDefinitions.codemode = createCodemodeToolDefinition({
			getTools: () => this._tools.getCodemodeTools(),
			getBranch: () => this.sessionManager.getBranch(),
			appendEntry: (customType, data) => {
				const id = this.sessionManager.appendCustomEntry(customType, data);
				const entry = this.sessionManager.getEntry(id);
				if (entry) this._emit({ type: "entry_appended", entry });
			},
			get wasm() {
				return wasmPath ? loadQuickJSWasm(wasmPath) : undefined;
			},
			workerUrl: getCodemodeWorkerUrl(),
			executeTool: async (name, args, { signal, parentToolCallId }) => {
				const model = this.model;
				const assistantMessage = this._lastAssistantMessage;
				if (!model || !assistantMessage) throw new Error("Codemode requires an active assistant tool call");
				return runToolCall({
					toolCall: { type: "toolCall", id: randomUUID(), name, arguments: args as JsonObject },
					assistantMessage,
					context: {
						messages: this.agent.state.messages,
						tools: this._tools.getCodemodeTools(),
					},
					config: {
						model,
						beforeToolCall: (context) => this._beforeToolCall(context),
						afterToolCall: (context) => this._afterToolCall(context),
					},
					signal,
					parentToolCallId,
					emit: (event) => {
						this._emit(event as AgentSessionEvent);
						return undefined;
					},
				});
			},
		});
		baseToolDefinitions.search_mcp_tools = createSearchMcpToolsDefinition(() => this._tools.getCodemodeTools());
		this._tools.setBaseDefinitions(baseToolDefinitions);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this._modelRuntime,
		);
		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? this._withCodemodeSelection(defaultActiveToolNames);
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
		const hasProviderRegistrations = this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);
		return hasProviderRegistrations;
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		await this.settingsManager.reload();
		await this._resourceLoader.reload();
		await this._mcp?.reload();
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		oldRunner.invalidate();
		this.syncQueueModesFromSettings();
		const hasProviderRegistrations = this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});
		if (hasProviderRegistrations) await this._modelRuntime.refresh({ allowNetwork: false });

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	private _finishCancelledRetry(): void {
		if (this._retryAttempt === 0) return;
		const attempt = this._retryAttempt;
		this._retryAttempt = 0;
		this._emit({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: "Retry cancelled",
		});
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage, assistantEntryId?: string): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = retryDelayMs(settings, this._retryAttempt);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Keep the failed attempt in raw history while durably omitting it from model projection.
		if (assistantEntryId === undefined)
			throw new Error("Cannot omit retry attempt without its committed journal entry ID");
		this._omitRecoveryAttempt([assistantEntryId]);

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		const settleOperation = this._trackOperation();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			this._finishCancelledRetry();
			return false;
		} finally {
			this._retryAbortController = undefined;
			settleOperation();
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	async setAutoRetryEnabled(enabled: boolean): Promise<void> {
		await this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);
		const settleOperation = this._trackOperation();

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const eventResult = await this._extensionRunner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext: options?.excludeFromContext ?? false,
				cwd: this.sessionManager.getCwd(),
			});
			if (abortController.signal.aborted) {
				const result = { output: "", exitCode: undefined, cancelled: true, truncated: false };
				this.recordBashResult(command, result, options);
				return result;
			}
			const onOutput = (delta: string) => {
				onChunk?.(delta);
				this._emit({ type: "bash_execution_update", id: options?.id, delta });
			};
			const result =
				eventResult?.result ??
				(await executeBashWithOperations(
					resolvedCommand,
					this.sessionManager.getCwd(),
					eventResult?.operations ?? options?.operations ?? createLocalBashOperations({ shellPath }),
					{ onChunk: onOutput, signal: abortController.signal },
				));
			if (eventResult?.result) onOutput(result.output);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
			settleOperation();
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	private recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			this.sessionManager.appendMessage(bashMessage);
		}
		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}
		if (this.isCompacting) {
			throw new Error(
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
		}

		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		const summarySnapshot = options.summarize ? { model: this.model, thinkingLevel: this.thinkingLevel } : undefined;
		if (options.summarize && !summarySnapshot?.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize } = collectEntriesForBranchSummary(this.sessionManager, oldLeafId, targetId);

		// Prepare event data - mutable so extensions can override
		const customInstructions = options.customInstructions;
		const replaceInstructions = options.replaceInstructions;
		const label = options.label;

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();
		const settleOperation = this._trackOperation();

		try {
			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0) {
				const snapshot = summarySnapshot;
				if (!snapshot?.model) throw new Error("No model available for summarization");
				const {
					model: requestModel,
					apiKey,
					headers,
					env,
				} = await this._getSummarizationRequestAuth(snapshot.model, this._branchSummaryAbortController.signal);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model: requestModel,
					thinkingLevel: snapshot.thinkingLevel,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					false,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update finalized context from the canonical session projection.
			this._restoreToolsFromTranscript();

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
			settleOperation();
			void this._drainPendingCompactionInputs();
			this._resolveIdleWaitIfIdle();
		}
	}

	getContextUsage(): ContextUsage | undefined {
		return this.sessionManager.getContextUsage(this.model);
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
