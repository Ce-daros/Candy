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
import {
	type CreateAgentSessionRuntimeFactory,
	createRuntimeFromFactory,
	type AgentSessionRuntime as RuntimeHost,
} from "./agent-session-runtime.ts";
import { assembleAgentSessionFromServices, assembleAgentSessionServices } from "./agent-session-services.ts";
import type { CreateModelRuntimeOptions } from "./model-runtime.ts";
import type { DefaultResourceLoaderOptions, ResourceLoader } from "./resource-loader.ts";
import { createSessionCommandActions } from "./session-command-actions.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";

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

class SessionClient {
	#session: AgentSession;
	constructor(session: AgentSession) {
		this.#session = session;
	}
	subscribe = (...args: Parameters<AgentSession["subscribe"]>) => this.#session.subscribe(...args);
	prompt = (...args: Parameters<AgentSession["prompt"]>) => this.#session.prompt(...args);
	steer = (...args: Parameters<AgentSession["steer"]>) => this.#session.steer(...args);
	followUp = (...args: Parameters<AgentSession["followUp"]>) => this.#session.followUp(...args);
	sendCustomMessage = (...args: Parameters<AgentSession["sendCustomMessage"]>) =>
		this.#session.sendCustomMessage(...args);
	sendUserMessage = (...args: Parameters<AgentSession["sendUserMessage"]>) => this.#session.sendUserMessage(...args);
	executeCommand = (...args: Parameters<AgentSession["executeCommand"]>) => this.#session.executeCommand(...args);
	getCommands = (...args: Parameters<AgentSession["getCommands"]>) => this.#session.getCommands(...args);
	abort = (...args: Parameters<AgentSession["abort"]>) => this.#session.abort(...args);
	waitForIdle = (...args: Parameters<AgentSession["waitForIdle"]>) => this.#session.waitForIdle(...args);
	setModel = (...args: Parameters<AgentSession["setModel"]>) => this.#session.setModel(...args);
	clearModel = (...args: Parameters<AgentSession["clearModel"]>) => this.#session.clearModel(...args);
	setThinkingLevel = (...args: Parameters<AgentSession["setThinkingLevel"]>) =>
		this.#session.setThinkingLevel(...args);
	cycleThinkingLevel = (...args: Parameters<AgentSession["cycleThinkingLevel"]>) =>
		this.#session.cycleThinkingLevel(...args);
	getAvailableThinkingLevels = (...args: Parameters<AgentSession["getAvailableThinkingLevels"]>) =>
		this.#session.getAvailableThinkingLevels(...args);
	supportsThinking = (...args: Parameters<AgentSession["supportsThinking"]>) =>
		this.#session.supportsThinking(...args);
	compact = (...args: Parameters<AgentSession["compact"]>) => this.#session.compact(...args);
	abortCompaction = (...args: Parameters<AgentSession["abortCompaction"]>) => this.#session.abortCompaction(...args);
	setActiveToolsByName = (names: string[]) => this.#session.resources.setActiveTools(names);
	getActiveToolNames = (...args: Parameters<AgentSession["getActiveToolNames"]>) =>
		this.#session.getActiveToolNames(...args);
	getAllTools = (...args: Parameters<AgentSession["getAllTools"]>) => this.#session.getAllTools(...args);
	getToolDefinition = (...args: Parameters<AgentSession["getToolDefinition"]>) =>
		this.#session.getToolDefinition(...args);
	clearQueue = (...args: Parameters<AgentSession["clearQueue"]>) => this.#session.clearQueue(...args);
	getSteeringMessages = (...args: Parameters<AgentSession["getSteeringMessages"]>) =>
		this.#session.getSteeringMessages(...args);
	getFollowUpMessages = (...args: Parameters<AgentSession["getFollowUpMessages"]>) =>
		this.#session.getFollowUpMessages(...args);
	setSteeringMode = (...args: Parameters<AgentSession["setSteeringMode"]>) => this.#session.setSteeringMode(...args);
	setFollowUpMode = (...args: Parameters<AgentSession["setFollowUpMode"]>) => this.#session.setFollowUpMode(...args);
	setAutoCompactionEnabled = (...args: Parameters<AgentSession["setAutoCompactionEnabled"]>) =>
		this.#session.setAutoCompactionEnabled(...args);
	setAutoRetryEnabled = (...args: Parameters<AgentSession["setAutoRetryEnabled"]>) =>
		this.#session.setAutoRetryEnabled(...args);
	setCacheWarmingMode = (...args: Parameters<AgentSession["setCacheWarmingMode"]>) =>
		this.#session.setCacheWarmingMode(...args);
	executeBash = (...args: Parameters<AgentSession["executeBash"]>) => this.#session.executeBash(...args);
	abortBash = (...args: Parameters<AgentSession["abortBash"]>) => this.#session.abortBash(...args);
	setSessionName = (...args: Parameters<AgentSession["setSessionName"]>) => this.#session.setSessionName(...args);
	navigateTree = (...args: Parameters<AgentSession["navigateTree"]>) => this.#session.navigateTree(...args);
	getUserMessagesForForking = (...args: Parameters<AgentSession["getUserMessagesForForking"]>) =>
		this.#session.getUserMessagesForForking(...args);
	getSessionStats = (...args: Parameters<AgentSession["getSessionStats"]>) => this.#session.getSessionStats(...args);
	getContextUsage = (...args: Parameters<AgentSession["getContextUsage"]>) => this.#session.getContextUsage(...args);
	exportToJsonl = (...args: Parameters<AgentSession["exportToJsonl"]>) => this.#session.exportToJsonl(...args);
	getLastAssistantText = (...args: Parameters<AgentSession["getLastAssistantText"]>) =>
		this.#session.getLastAssistantText(...args);
	reload = () => this.#session.resources.reload();
	get model() {
		return structuredClone(this.#session.model);
	}
	get thinkingLevel() {
		return this.#session.thinkingLevel;
	}
	get isStreaming() {
		return this.#session.isStreaming;
	}
	get isIdle() {
		return this.#session.isIdle;
	}
	get isCompacting() {
		return this.#session.isCompacting;
	}
	get isDisposed() {
		return this.#session.isDisposed;
	}
	get systemPrompt() {
		return this.#session.systemPrompt;
	}
	get sessionFile() {
		return this.#session.sessionFile;
	}
	get sessionId() {
		return this.#session.sessionId;
	}
	get sessionName() {
		return this.#session.sessionName;
	}
	get promptTemplates() {
		return structuredClone(this.#session.promptTemplates);
	}
	get steeringMode() {
		return this.#session.steeringMode;
	}
	get followUpMode() {
		return this.#session.followUpMode;
	}
	get pendingMessageCount() {
		return this.#session.pendingMessageCount;
	}
	get autoCompactionEnabled() {
		return this.#session.autoCompactionEnabled;
	}
	get autoRetryEnabled() {
		return this.#session.autoRetryEnabled;
	}
	get isRetrying() {
		return this.#session.isRetrying;
	}
	get isBashRunning() {
		return this.#session.isBashRunning;
	}
	get cacheWarmingStatus() {
		return this.#session.cacheWarmingStatus;
	}
	get messages() {
		return structuredClone(this.#session.messages) as readonly Readonly<agentCore.AgentMessage>[];
	}
	get resources() {
		return this.#session.resources;
	}
}
export type AgentSessionOperations = SessionClient;

class RuntimeClient {
	#host: RuntimeHost;
	constructor(host: RuntimeHost) {
		this.#host = host;
	}
	get session(): AgentSessionOperations {
		return new SessionClient(this.#host.session);
	}
	get cwd() {
		return this.#host.cwd;
	}
	get diagnostics() {
		return structuredClone(this.#host.diagnostics);
	}
	get modelFallbackMessage() {
		return this.#host.modelFallbackMessage;
	}
	get settings() {
		return this.#host.services.settingsManager;
	}
	get models() {
		return this.#host.services.modelRuntime;
	}
	get resources() {
		return this.#host.session.resources;
	}
	newSession(options?: Omit<NonNullable<Parameters<RuntimeHost["newSession"]>[0]>, "setup">) {
		return this.#host.newSession(options);
	}
	switchSession(...args: Parameters<RuntimeHost["switchSession"]>) {
		return this.#host.switchSession(...args);
	}
	fork(...args: Parameters<RuntimeHost["fork"]>) {
		return this.#host.fork(...args);
	}
	clone(...args: Parameters<RuntimeHost["clone"]>) {
		return this.#host.clone(...args);
	}
	importFromJsonl(...args: Parameters<RuntimeHost["importFromJsonl"]>) {
		return this.#host.importFromJsonl(...args);
	}
	dispose() {
		return this.#host.dispose();
	}
}
export type AgentSessionRuntime = RuntimeClient;

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
	const createRuntime: CreateAgentSessionRuntimeFactory = async (target) => {
		const services = await assembleAgentSessionServices({
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
		});
		try {
			const created = await assembleAgentSessionFromServices({
				services,
				sessionManager: target.sessionManager,
				sessionStartEvent: target.sessionStartEvent,
				model: options.model,
				thinkingLevel: options.thinkingLevel,
				tools: options.tools,
				excludeTools: options.excludeTools,
				noTools: options.noTools,
				customTools: options.customTools,
			});
			return { ...created, services, diagnostics: services.diagnostics };
		} catch (error) {
			try {
				await services.dispose();
			} catch (disposeError) {
				throw new AggregateError([error, disposeError], "Session creation and services cleanup failed");
			}
			throw error;
		}
	};
	const host = await createRuntimeFromFactory(createRuntime, {
		cwd,
		agentDir,
		sessionManager: options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir)),
		sessionStartEvent: options.sessionStartEvent,
	});
	try {
		await host.session.bindExtensions({ commandContextActions: createSessionCommandActions(host) });
	} catch (error) {
		try {
			await host.dispose();
		} catch (disposeError) {
			throw new AggregateError([error, disposeError], "Runtime initialization and disposal failed");
		}
		throw error;
	}
	host.setRebindSession(async (session) => {
		await session.bindExtensions({ commandContextActions: createSessionCommandActions(host) });
	});
	return new RuntimeClient(host);
}
