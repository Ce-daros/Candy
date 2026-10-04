import type { AgentMessage, AgentOptions, AgentTool, ThinkingLevel } from "@candy/agent-core";
import type { ModelsSimpleStreamOptions } from "@candy/ai";
import { clampThinkingLevel, type Message, type Model } from "@candy/ai";
import { AgentSession } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { CacheWarmer } from "./cache-warmer.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import type { McpRuntime } from "./mcp/runtime.ts";
import { convertToLlm } from "./messages.ts";
import { findInitialModel } from "./model-resolver.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { ResourceLoader, ResourceThemeAdapter } from "./resource-loader.ts";
import type { SessionHistory } from "./session-history.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface CreateAgentSessionOptions {
	baseToolsOverride?: Record<string, AgentTool>;
	initialActiveToolNames?: string[];
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.candy/agent */
	agentDir?: string;

	/** Canonical model/auth runtime. Defaults to a runtime using agentDir/auth.json and models.json. */
	modelRuntime?: ModelRuntime;
	mcp?: McpRuntime;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, edit, write)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, candy uses the `defaultTools` setting for the initial built-in
	 * selection when configured. Otherwise it enables the default built-in tools
	 * (read, bash, edit, write). Extension/custom tools remain enabled unless
	 * `noTools` changes that default. When provided, only the listed tool names are
	 * enabled.
	 */
	tools?: string[];
	/** Optional denylist of tool names to disable. Applies after `tools` when both are provided. */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;
	/** Required when the default resource loader loads presentation themes. */
	themeAdapter?: ResourceThemeAdapter;
	/** Required when the default resource loader loads extension source files. */
	extensionModules?: Record<string, unknown>;

	/** Session manager. Default: SessionHistory.create(cwd) */
	sessionManager?: SessionHistory;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
}

/** Result from assembleAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

export type AssembleAgentSessionOptions = CreateAgentSessionOptions & {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	sessionManager: SessionHistory;
	resourceLoader: ResourceLoader;
};

export async function assembleAgentSession(options: AssembleAgentSessionOptions): Promise<CreateAgentSessionResult> {
	const { cwd, agentDir, modelRuntime, settingsManager, sessionManager, resourceLoader } = options;

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRuntime.getModel(existingSession.model.provider, existingSession.model.modelId);
		if (
			restoredModel &&
			(await modelRuntime.getAvailability(restoredModel.provider)).providers.find(
				(provider) => provider.providerId === restoredModel.provider,
			)?.auth
		) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to per-model override, then global default
	if (thinkingLevel === undefined && model) {
		const perModel = settingsManager.getModelThinkingLevel(model.provider, model.id);
		if (perModel) {
			thinkingLevel = perModel;
		}
	}
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const defaultActiveToolNames = options.baseToolsOverride
		? Object.keys(options.baseToolsOverride)
		: ["read", "bash", "edit", "write"];
	const configuredDefaultToolNames = settingsManager.getDefaultTools();
	const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const excludedToolNames = options.excludeTools;
	const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
	const initialActiveToolNames = (
		options.initialActiveToolNames ??
		options.tools ??
		(options.noTools ? [] : (configuredDefaultToolNames ?? defaultActiveToolNames))
	).filter((name) => !excludedToolNameSet?.has(name));
	const explicitToolNames =
		options.initialActiveToolNames ??
		options.tools ??
		(options.noTools
			? []
			: (configuredDefaultToolNames ?? (options.baseToolsOverride ? defaultActiveToolNames : undefined)));

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.read("block-images")) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const resourceOwner = {};
	const cacheWarmer = new CacheWarmer(modelRuntime, sessionManager, () => settingsManager.read("cache-warming-mode"));
	const buildRequestOptions = (
		requestModel: Model<any>,
		options: ModelsSimpleStreamOptions = {},
	): ModelsSimpleStreamOptions => {
		const providerRetrySettings = settingsManager.getProviderRetrySettings();
		const httpIdleTimeoutMs = settingsManager.read("http-idle-timeout");
		const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
		return {
			...options,
			resourceOwner,
			timeoutMs: options.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs,
			websocketConnectTimeoutMs: options.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs(),
			maxRetries: options.maxRetries ?? providerRetrySettings.maxRetries,
			maxRetryDelayMs: options.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
			transformHeaders: async (requestHeaders) => {
				const headers = mergeProviderAttributionHeaders(
					requestModel,
					settingsManager,
					options.sessionId,
					requestHeaders,
				);
				return headers ?? {};
			},
		};
	};
	const cacheContextIsCurrent = (requestModel: Model<any>) => {
		const messages = session.execution.state.messages;
		return () => {
			const currentModel = session.execution.state.model;
			const currentMessages = session.execution.state.messages;
			if (!currentModel) return false;
			return (
				currentModel.provider === requestModel.provider &&
				currentModel.id === requestModel.id &&
				messages.length <= currentMessages.length &&
				messages.every((message, index) => currentMessages[index] === message)
			);
		};
	};
	const agentOptions: Omit<AgentOptions, "host" | "inputs"> = {
		initialState: {
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const requestOptions = buildRequestOptions(model, options);
			// Compaction and summaries use their own routing ids; only session requests
			// replace the cache entry, so warming restarts from them. Keep warming while
			// the current transcript still extends the request's prefix. Agent state may
			// shallow-copy the messages array or refresh the model object without changing
			// the provider request, so top-level object identity is not a valid cache key.
			if (options?.sessionId === sessionManager.getSessionId()) {
				cacheWarmer.start({ model, context, options: requestOptions }, cacheContextIsCurrent(model));
			}
			return modelRuntime.streamSimple(model, context, requestOptions);
		},
		sessionId: sessionManager.getSessionId(),
		transport: settingsManager.read("transport"),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	};

	// Restore missing settings metadata for older sessions.
	if (hasExistingSession) {
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		baseToolsOverride: options.baseToolsOverride,
		agentOptions,
		sessionManager,
		settingsManager,
		cwd,
		agentDir,
		resourceLoader,
		customTools: options.customTools,
		modelRuntime,
		mcp: options.mcp,
		cacheWarmer,
		initialActiveToolNames,
		initialCodemodeSelection: explicitToolNames?.includes("codemode"),
		allowedToolNames,
		excludedToolNames,
		sessionStartEvent: options.sessionStartEvent,
		resourceOwner,
	});

	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
