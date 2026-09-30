import { join } from "node:path";
import type { ThinkingLevel } from "@candy/agent-core";
import type { Model } from "@candy/ai";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import {
	assembleAgentSession,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
} from "./agent-session-factory.ts";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { type CreateModelRuntimeOptions, ModelRuntime } from "./model-runtime.ts";
import {
	DefaultResourceLoader,
	type DefaultResourceLoaderOptions,
	type ResourceLoader,
	type ResourceLoaderReloadOptions,
} from "./resource-loader.ts";
import type { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * Runtime creation returns diagnostics to the caller instead of printing or
 * exiting. The app layer decides whether warnings should be shown and whether
 * errors should abort startup.
 */
export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
export interface CreateAgentSessionServicesOptions {
	cwd: string;
	agentDir?: string;
	settingsManager?: SettingsManager;
	resourceLoader?: ResourceLoader;
	modelRuntime?: ModelRuntime;
	modelRuntimeOptions?: Omit<CreateModelRuntimeOptions, "signal" | "refreshOnCreate">;
	modelRuntimeSignal?: AbortSignal;
	extensionFlagValues?: Map<string, boolean | string>;
	resourceLoaderOptions?: Omit<
		DefaultResourceLoaderOptions,
		"cwd" | "agentDir" | "settingsManager" | "themeAdapter" | "extensionModules"
	>;
	themeAdapter?: DefaultResourceLoaderOptions["themeAdapter"];
	extensionModules?: DefaultResourceLoaderOptions["extensionModules"];
	resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
}

/**
 * Inputs for creating an AgentSession from already-created services.
 *
 * Use this after services exist and any cwd-bound model/tool/session options
 * have been resolved against those services.
 */
export interface CreateAgentSessionFromServicesOptions {
	services: AgentSessionServices;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	excludeTools?: CreateAgentSessionOptions["excludeTools"];
	noTools?: CreateAgentSessionOptions["noTools"];
	customTools?: ToolDefinition[];
}

/**
 * Coherent cwd-bound runtime services for one effective session cwd.
 *
 * This is infrastructure only. The AgentSession itself is created separately so
 * session options can be resolved against these services first.
 */
export interface AgentSessionServices {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	resourceLoader: ResourceLoader;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	dispose(): Promise<void>;
}

function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	return diagnostics;
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. It does not create an AgentSession.
 */
export async function assembleAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const cwd = resolvePath(options.cwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	const modelRuntime =
		options.modelRuntime ??
		(await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			...options.modelRuntimeOptions,
			signal: options.modelRuntimeSignal,
			refreshOnCreate: false,
		}));
	const ownsModelRuntime = options.modelRuntime === undefined;
	try {
		const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
		const resourceLoader =
			options.resourceLoader ??
			new DefaultResourceLoader({
				...(options.resourceLoaderOptions ?? {}),
				cwd,
				agentDir,
				settingsManager,
				themeAdapter: options.themeAdapter,
				extensionModules: options.extensionModules,
			});
		if (!options.resourceLoader) await resourceLoader.reload(options.resourceLoaderReloadOptions);

		const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
		const extensionsResult = resourceLoader.getExtensions();
		for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
			try {
				modelRuntime.registerProvider(name, config);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				diagnostics.push({
					type: "error",
					message: `Extension "${extensionPath}" error: ${message}`,
				});
			}
		}
		extensionsResult.runtime.pendingProviderRegistrations = [];
		for (const { provider, extensionPath } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
			try {
				modelRuntime.registerNativeProvider(provider);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				diagnostics.push({
					type: "error",
					message: `Extension "${extensionPath}" error: ${message}`,
				});
			}
		}
		extensionsResult.runtime.pendingNativeProviderRegistrations = [];
		await modelRuntime.refresh({ allowNetwork: false });
		diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

		let disposePromise: Promise<void> | undefined;
		return {
			cwd,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoader,
			diagnostics,
			dispose: () => {
				disposePromise ??= ownsModelRuntime ? modelRuntime.dispose() : Promise.resolve();
				return disposePromise;
			},
		};
	} catch (error) {
		if (!ownsModelRuntime) throw error;
		try {
			await modelRuntime.dispose();
		} catch (disposeError) {
			throw new AggregateError([error, disposeError], "Runtime services creation and cleanup failed");
		}
		throw error;
	}
}

/**
 * Create an AgentSession from previously created services.
 *
 * This keeps session creation separate from service creation so callers can
 * resolve model, thinking, tools, and other session inputs against the target
 * cwd before constructing the session.
 */
export async function assembleAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	return assembleAgentSession({
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		modelRuntime: options.services.modelRuntime,
		settingsManager: options.services.settingsManager,
		resourceLoader: options.services.resourceLoader,
		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		tools: options.tools,
		excludeTools: options.excludeTools,
		noTools: options.noTools,
		customTools: options.customTools,
		sessionStartEvent: options.sessionStartEvent,
	});
}
