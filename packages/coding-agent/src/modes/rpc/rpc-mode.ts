import { createSessionCommandActions } from "../../core/session-command-actions.ts";
/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import type { ElicitResult } from "@modelcontextprotocol/client";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../../core/extensions/index.ts";
import type { McpInteractionRequest } from "../../core/mcp/types.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import type { ResourceType } from "../../core/resource-configuration.ts";
import type { SettingsScope } from "../../core/settings-manager.ts";
import { commitInteractiveSetting, isInteractiveSettingId } from "../../core/settings-operations.ts";
import { exportSessionHtml } from "../../presentation/session-html-export.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { toJsonEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSettingsCommitEvent,
} from "./rpc-types.ts";

const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const satisfies readonly ResourceType[];

function isSettingsScope(value: unknown): value is SettingsScope {
	return value === "global" || value === "project";
}

function isResourceType(value: unknown): value is ResourceType {
	return typeof value === "string" && RESOURCE_TYPES.includes(value as ResourceType);
}

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSettingsCommitEvent,
} from "./rpc-types.ts";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeSettings: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// Shutdown request flag
	let shutdownRequested = false;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWidget(key: string, content: string[] | undefined): void {
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setWidget",
				widgetKey: key,
				widgetLines: content,
			});
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},
	});

	const handleMcpInteraction = (request: McpInteractionRequest, signal?: AbortSignal): Promise<ElicitResult> =>
		createDialogPromise(
			{ signal },
			{ action: "cancel" } as ElicitResult,
			request.type === "elicitation"
				? { method: "mcp_elicitation", server: request.server, request: request.request }
				: { method: "mcp_authorization", server: request.server, url: request.url },
			(response) =>
				"action" in response
					? ({ action: response.action, content: response.content } as ElicitResult)
					: { action: "cancel" },
		);

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		runtimeHost.mcp.setInteraction(handleMcpInteraction);
		await session.execution.bindExtensions({
			uiContext: createExtensionUIContext(),
			mode: "rpc",
			commandContextActions: createSessionCommandActions(runtimeHost),
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		unsubscribe?.();
		unsubscribeSettings?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.execution.subscribe((event) => {
			output(toJsonEvent(event));
			if (event.type === "agent_settled") {
				void checkShutdownRequested();
			}
		});
		unsubscribeBackpressure = session.execution.subscribeExecution(async () => {
			await waitForRawStdoutBackpressure();
		});
		unsubscribeSettings = runtimeHost.settings.subscribe((event) => {
			const settingsEvent: RpcSettingsCommitEvent = {
				type: "settings_commit",
				scope: event.scope,
				fields: [...event.fields],
			};
			output(settingsEvent);
		});
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	await rebindSession();
	registerSignalHandlers();

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				let preflightSucceeded = false;
				void session.execution
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (disposition) => {
							preflightSucceeded = true;
							output(success(id, "prompt", { disposition }));
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							output(error(id, "prompt", e.message));
						}
					});
				return undefined;
			}

			case "execute_command": {
				let preflightSucceeded = false;
				void session.execution
					.executeCommand(
						{ source: command.source, name: command.name, args: command.args },
						{
							streamingBehavior: command.streamingBehavior,
							source: "rpc",
							preflightResult: (disposition) => {
								preflightSucceeded = true;
								output(success(id, "execute_command", { disposition }));
							},
						},
					)
					.catch((e) => {
						if (!preflightSucceeded) output(error(id, "execute_command", e.message));
					});
				return undefined;
			}

			case "steer": {
				const disposition = await session.execution.steer(command.message, command.images, { source: "rpc" });
				return success(id, "steer", { disposition });
			}

			case "follow_up": {
				const disposition = await session.execution.followUp(command.message, command.images, { source: "rpc" });
				return success(id, "follow_up", { disposition });
			}

			case "abort": {
				await session.execution.abort();
				return success(id, "abort");
			}

			case "clear_queue": {
				return success(id, "clear_queue", session.execution.clearQueue());
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.selection.model,
					thinkingLevel: session.selection.thinkingLevel,
					isStreaming: session.execution.isStreaming,
					isCompacting: session.execution.isCompacting,
					steeringMode: session.execution.steeringMode,
					followUpMode: session.execution.followUpMode,
					sessionFile: session.execution.sessionFile,
					sessionId: session.execution.sessionId,
					sessionName: session.execution.sessionName,
					autoCompactionEnabled: session.execution.autoCompactionEnabled,
					messageCount: session.execution.messages.length,
					pendingMessageCount: session.execution.pendingMessageCount,
					mcpServers: runtimeHost.mcp.list(),
				};
				return success(id, "get_state", state);
			}

			case "get_settings": {
				return success(id, "get_settings", {
					global: runtimeHost.settings.getGlobalSettings(),
					project: runtimeHost.settings.getProjectSettings(),
					projectTrusted: runtimeHost.settings.isProjectTrusted(),
				});
			}

			case "mcp_list":
				return success(id, command.type, { servers: runtimeHost.mcp.list() });
			case "mcp_reconnect":
				await runtimeHost.mcp.reconnect(command.name);
				return success(id, command.type);
			case "mcp_set_enabled":
				await runtimeHost.mcp.setEnabled(command.name, command.enabled, command.scope);
				return success(id, command.type);
			case "mcp_set_exposure":
				await runtimeHost.mcp.setExposure(command.name, command.exposure, command.scope);
				return success(id, command.type);
			case "mcp_login":
				await runtimeHost.mcp.login(command.name);
				return success(id, command.type);
			case "mcp_logout":
				await runtimeHost.mcp.logout(command.name);
				return success(id, command.type);

			case "commit_setting": {
				if (!isSettingsScope(command.scope))
					return error(id, command.type, `Invalid settings scope: ${String(command.scope)}`);
				if (!isInteractiveSettingId(command.settingId))
					return error(id, command.type, `Unknown setting: ${String(command.settingId)}`);
				if (command.clear !== undefined && typeof command.clear !== "boolean") {
					return error(id, command.type, "clear must be a boolean");
				}
				const clear = command.clear === true;
				const hasValue = Object.hasOwn(command, "value");
				if (clear === hasValue) {
					return error(id, command.type, "Provide exactly one of value or clear: true");
				}
				await commitInteractiveSetting(runtimeHost.settings, command.scope, command.settingId, command.value, {
					clear,
				});
				return success(id, command.type, { scope: command.scope, settingId: command.settingId, cleared: clear });
			}

			case "save_default_model": {
				if (
					typeof command.provider !== "string" ||
					typeof command.modelId !== "string" ||
					!command.provider.trim() ||
					!command.modelId.trim()
				) {
					return error(id, command.type, "Provider and model ID must not be empty");
				}
				await runtimeHost.settings.setDefaultModelAndProvider(command.provider, command.modelId);
				return success(id, command.type);
			}

			case "get_resources": {
				return success(id, command.type, session.resources.getInventory());
			}

			case "get_resource_configuration": {
				if (!isSettingsScope(command.scope))
					return error(id, command.type, `Invalid settings scope: ${String(command.scope)}`);
				const { paths } = await session.resources.getConfiguration(command.scope);
				const items = (["extensions", "skills", "prompts", "themes"] as const).flatMap((resourceType) =>
					paths[command.scope][resourceType].map((item) => ({ ...item, resourceType })),
				);
				return success(id, command.type, { scope: command.scope, paths, items });
			}

			case "toggle_resource": {
				if (!isSettingsScope(command.scope))
					return error(id, command.type, `Invalid settings scope: ${String(command.scope)}`);
				if (!isResourceType(command.resourceType))
					return error(id, command.type, `Unknown resource type: ${String(command.resourceType)}`);
				if (typeof command.path !== "string") return error(id, command.type, "path must be a string");
				const { paths, operations } = await session.resources.getConfiguration(command.scope);
				const item = paths[command.scope][command.resourceType].find(
					(candidate) => candidate.path === command.path,
				);
				if (!item)
					return error(id, command.type, `Resource not found in ${command.scope} configuration: ${command.path}`);
				const enabled = await operations.toggleResource({ ...item, resourceType: command.resourceType });
				return success(id, command.type, { enabled: enabled ?? null });
			}

			case "active_tools": {
				if (command.action === "set") {
					if (!Array.isArray(command.names) || command.names.some((name) => typeof name !== "string")) {
						return error(id, command.type, "names must be an array of tool names");
					}
					session.resources.setActiveTools(command.names);
				}
				return success(id, command.type, { names: session.execution.getActiveToolNames() });
			}

			case "default_tools": {
				if (command.action === "save") {
					const clear = command.clear === true;
					if (command.clear !== undefined && typeof command.clear !== "boolean") {
						return error(id, command.type, "clear must be a boolean");
					}
					if (clear === Object.hasOwn(command, "names")) {
						return error(id, command.type, "Provide exactly one of names or clear: true");
					}
					if (
						!clear &&
						(!Array.isArray(command.names) || command.names.some((name) => typeof name !== "string"))
					) {
						return error(id, command.type, "names must be an array of tool names");
					}
					await session.resources.saveDefaultTools(clear ? undefined : command.names);
				}
				return success(id, command.type, { names: runtimeHost.settings.getDefaultTools() ?? null });
			}

			case "read_instruction": {
				if (typeof command.path !== "string") return error(id, command.type, "path must be a string");
				const content = await session.resources.readInstruction(command.path);
				return success(id, command.type, { content });
			}

			case "save_instruction": {
				if (typeof command.path !== "string" || typeof command.content !== "string") {
					return error(id, command.type, "path and content must be strings");
				}
				const result = await session.resources.saveInstruction(command.path, command.content);
				return success(id, command.type, {
					saved: result.saved,
					reloaded: result.reloaded,
					...(!result.reloaded ? { error: result.error.message } : {}),
				});
			}

			case "reload_resources": {
				await session.resources.reload();
				return success(id, command.type);
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = session.execution.modelRuntime.getAvailableSnapshot();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.selection.setModel(model);
				return success(id, "set_model", model);
			}

			case "get_available_models": {
				const models = session.execution.modelRuntime.getAvailableSnapshot();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.selection.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.selection.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				const levels = session.selection.getAvailableThinkingLevels();
				return success(id, "get_available_thinking_levels", { levels });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				await session.execution.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				await session.execution.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.execution.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				await session.execution.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				await session.execution.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.execution.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.execution.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
					id,
				});
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.execution.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.history.getSessionStats(session.selection.model);
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await exportSessionHtml(session, command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "import_session": {
				const result = await runtimeHost.importFromJsonl(command.inputPath, command.cwdOverride);
				if (!result.cancelled) await rebindSession();
				return success(id, "import_session", result);
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const result = await runtimeHost.clone();
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.history.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_entries": {
				const sessionManager = session.history;
				let entries = sessionManager.getEntries();
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex((e) => e.id === command.since);
					if (sinceIndex === -1) {
						return error(id, "get_entries", `Entry not found: ${command.since}`);
					}
					entries = entries.slice(sinceIndex + 1);
				}
				return success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
			}

			case "get_tree": {
				const sessionManager = session.history;
				return success(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
			}

			case "get_last_assistant_text": {
				const text = session.history.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.execution.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.execution.messages });
			}

			// =================================================================
			// Commands
			// =================================================================

			case "get_commands": {
				return success(id, "get_commands", { commands: session.execution.getCommands() });
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
		detachInput();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			await waitForRawStdoutBackpressure();
			return;
		}

		// Handle extension UI responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRawStdoutBackpressure();
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
			await waitForRawStdoutBackpressure();
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
