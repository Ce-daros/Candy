import { createSessionCommandActions } from "../core/session-command-actions.ts";
/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `candy -p "prompt"` - text output
 * - `candy --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@candy/ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { toJsonEvent } from "./json-event.ts";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let signalExitCode: number | undefined;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let disposePromise: Promise<void> | undefined;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeRuntime = (): Promise<void> => {
		disposePromise ??= (async () => {
			unsubscribe?.();
			unsubscribeBackpressure?.();
			await runtimeHost.dispose();
		})();
		return disposePromise;
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				signalExitCode = signal === "SIGHUP" ? 129 : 143;
				killTrackedDetachedChildren();
				void disposeRuntime().catch((error: unknown) => {
					console.error(error instanceof Error ? error.message : String(error));
					signalExitCode = 1;
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.execution.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: createSessionCommandActions(runtimeHost),
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.execution.subscribe((event) => {
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`);
			}
		});
		unsubscribeBackpressure =
			mode === "json"
				? session.execution.subscribeExecution(async () => {
						await waitForRawStdoutBackpressure();
					})
				: undefined;
	};

	try {
		if (mode === "json") {
			const header = session.history.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		if (initialMessage) {
			await session.execution.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			await session.execution.prompt(message);
		}

		if (mode === "text") {
			const state = session.execution.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
				}
			}
		}

		return signalExitCode ?? exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return signalExitCode ?? 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
