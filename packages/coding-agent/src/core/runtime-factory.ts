import * as agentCore from "@candy/agent-core";
import * as ai from "@candy/ai";
import * as oauth from "@candy/ai/oauth";
import * as providers from "@candy/ai/providers/all";
import * as typebox from "typebox";
import * as typeboxCompile from "typebox/compile";
import * as typeboxValue from "typebox/value";
import { getAgentDir } from "../config.ts";
import * as extensionApi from "../extension-api.ts";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { CreateAgentSessionOptions } from "./agent-session-factory.ts";
import { createRuntimeFromFactory, type AgentSessionRuntime as RuntimeHost } from "./agent-session-runtime.ts";
import type { CreateModelRuntimeOptions } from "./model-runtime.ts";
import type { DefaultResourceLoaderOptions, ResourceLoader } from "./resource-loader.ts";
import { buildRuntimeFactory } from "./runtime-builder.ts";
import { createSessionCommandActions } from "./session-command-actions.ts";
import { getDefaultSessionDir, SessionHistory } from "./session-history.ts";

export interface CreateAgentSessionRuntimeOptions
	extends Omit<CreateAgentSessionOptions, "resourceLoader" | "baseToolsOverride" | "initialActiveToolNames"> {
	modelRuntimeOptions?: Omit<CreateModelRuntimeOptions, "signal" | "refreshOnCreate">;
	resourceLoaderFactory?: (target: { cwd: string; agentDir: string }) => ResourceLoader | Promise<ResourceLoader>;
	resourceLoaderOptions?: Omit<
		DefaultResourceLoaderOptions,
		"cwd" | "agentDir" | "settingsManager" | "extensionModules" | "themeAdapter"
	>;
	extensionFlagValues?: Map<string, boolean | string>;
	signal?: AbortSignal;
}

const executionKeys = [
	"prompt",
	"executeCommand",
	"getCommands",
	"steer",
	"followUp",
	"clearQueue",
	"getSteeringMessages",
	"getFollowUpMessages",
	"pendingMessageCount",
	"isStreaming",
	"isCompacting",
	"isIdle",
	"isDisposed",
	"isRetrying",
	"retryAttempt",
	"subscribe",
	"abort",
	"waitForIdle",
	"compact",
	"abortCompaction",
	"abortBranchSummary",
	"abortRetry",
	"executeBash",
	"abortBash",
	"isBashRunning",
	"hasPendingBashMessages",
	"navigateTree",
	"setSessionName",
	"sendCustomMessage",
	"sendUserMessage",
	"cacheWarmingStatus",
	"systemPrompt",
] as const satisfies readonly (keyof AgentSession["execution"])[];
const historyKeys = [
	"getCwd",
	"getSessionDir",
	"getSessionId",
	"getSessionFile",
	"getLeafId",
	"getLeafEntry",
	"getEntry",
	"getLabel",
	"getBranch",
	"buildContextEntries",
	"buildSessionProjection",
	"buildSessionContext",
	"getHeader",
	"getEntries",
	"getTree",
	"getSessionName",
	"isPersisted",
	"getSessionStats",
	"getContextUsage",
	"getLastAssistantText",
	"getUserMessagesForForking",
	"exportToJsonl",
] as const satisfies readonly (keyof AgentSession["history"])[];
const selectionKeys = [
	"model",
	"thinkingLevel",
	"getAvailableThinkingLevels",
	"supportsThinking",
	"setModel",
	"clearModel",
	"setThinkingLevel",
	"cycleThinkingLevel",
] as const satisfies readonly (keyof AgentSession["selection"])[];
const resourcesKeys = [
	"getActiveTools",
	"getTools",
	"getInventory",
	"getConfiguration",
	"readInstruction",
	"saveInstruction",
	"setActiveTools",
	"saveDefaultTools",
	"reload",
] as const satisfies readonly (keyof AgentSession["resources"])[];
export interface AgentSessionOperations {
	readonly execution: Pick<AgentSession["execution"], (typeof executionKeys)[number]>;
	readonly history: Pick<AgentSession["history"], (typeof historyKeys)[number]>;
	readonly selection: Pick<AgentSession["selection"], (typeof selectionKeys)[number]>;
	readonly resources: Pick<AgentSession["resources"], (typeof resourcesKeys)[number]>;
}
export type AgentSessionRuntime = Pick<
	RuntimeHost,
	| "cwd"
	| "diagnostics"
	| "modelFallbackMessage"
	| "settings"
	| "models"
	| "newSession"
	| "switchSession"
	| "fork"
	| "clone"
	| "importFromJsonl"
	| "dispose"
> & { readonly session: AgentSessionOperations; readonly resources: AgentSessionOperations["resources"] };

function capability<T extends object, const Keys extends readonly (keyof T)[]>(
	owner: T,
	keys: Keys,
): Pick<T, Keys[number]> {
	const descriptors = Object.fromEntries(
		keys.map((key) => [
			key,
			{
				enumerable: true,
				get() {
					const value = Reflect.get(owner, key);
					return typeof value === "function" ? value.bind(owner) : value;
				},
			},
		]),
	);
	return Object.freeze(Object.defineProperties({}, descriptors)) as Pick<T, Keys[number]>;
}

export async function createAgentSessionRuntime(
	options: CreateAgentSessionRuntimeOptions = {},
): Promise<AgentSessionRuntime> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = resolvePath(options.agentDir ?? getAgentDir());
	const extensionModules = options.extensionModules ?? {
		typebox,
		"typebox/compile": typeboxCompile,
		"typebox/value": typeboxValue,
		"@candy/agent-core": agentCore,
		"@candy/ai": ai,
		"@candy/ai/oauth": oauth,
		"@candy/ai/providers/all": providers,
		"@candy/coding-agent": { ...extensionApi, createAgentSessionRuntime },
	};
	const createRuntime = buildRuntimeFactory({
		services: async (target) => ({
			options: {
				cwd: target.cwd,
				agentDir: target.agentDir,
				modelRuntime: options.modelRuntime,
				modelRuntimeOptions: options.modelRuntimeOptions,
				modelRuntimeSignal: options.signal,
				settingsManager: options.settingsManager,
				resourceLoader: await options.resourceLoaderFactory?.(target),
				resourceLoaderOptions: options.resourceLoaderOptions,
				themeAdapter: options.themeAdapter,
				extensionModules,
				extensionFlagValues: options.extensionFlagValues,
			},
		}),
		select: async () => ({
			options: {
				model: options.model,
				thinkingLevel: options.thinkingLevel,
				tools: options.tools,
				excludeTools: options.excludeTools,
				noTools: options.noTools,
				customTools: options.customTools,
			},
		}),
	});
	const host = await createRuntimeFromFactory(createRuntime, {
		cwd,
		agentDir,
		sessionManager: options.sessionManager ?? SessionHistory.create(cwd, getDefaultSessionDir(cwd, agentDir)),
		sessionStartEvent: options.sessionStartEvent,
	});
	try {
		await host.session.execution.bindExtensions({ commandContextActions: createSessionCommandActions(host) });
	} catch (error) {
		try {
			await host.dispose();
		} catch (disposeError) {
			throw new AggregateError([error, disposeError], "Runtime initialization and disposal failed");
		}
		throw error;
	}
	host.setRebindSession(async (session) => {
		await session.execution.bindExtensions({ commandContextActions: createSessionCommandActions(host) });
	});
	const sessions = new WeakMap<AgentSession, AgentSessionOperations>();
	const getSession = (): AgentSessionOperations => {
		const current = host.session;
		let view = sessions.get(current);
		if (!view) {
			view = Object.freeze({
				execution: capability(current.execution, executionKeys),
				history: capability(current.history, historyKeys),
				selection: capability(current.selection, selectionKeys),
				resources: capability(current.resources, resourcesKeys),
			});
			sessions.set(current, view);
		}
		return view;
	};
	return Object.freeze({
		get session() {
			return getSession();
		},
		get cwd() {
			return host.cwd;
		},
		get diagnostics() {
			return host.diagnostics;
		},
		get modelFallbackMessage() {
			return host.modelFallbackMessage;
		},
		get settings() {
			return host.settings;
		},
		get models() {
			return host.models;
		},
		get resources() {
			return getSession().resources;
		},
		newSession: host.newSession.bind(host),
		switchSession: host.switchSession.bind(host),
		fork: host.fork.bind(host),
		clone: host.clone.bind(host),
		importFromJsonl: host.importFromJsonl.bind(host),
		dispose: host.dispose.bind(host),
	});
}
