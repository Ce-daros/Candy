import { Buffer } from "node:buffer";
import type { AgentTool } from "@candy/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@candy/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import { createHarness, type Harness } from "./harness.ts";

function getEntryTypes(harness: Harness): string[] {
	return harness.sessionManager.getEntries().map((entry) => entry.type);
}

interface ControlledBashInvocation {
	signal: AbortSignal | undefined;
	finish: () => void;
}

function createControlledBashOperations(invocations: ControlledBashInvocation[]): BashOperations {
	return {
		exec: async (_command, _cwd, options) => {
			return await new Promise<{ exitCode: number | null }>((resolve) => {
				invocations.push({
					signal: options.signal,
					finish: () => resolve({ exitCode: 0 }),
				});
			});
		},
	};
}

describe("AgentSession bash and persistence characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("records bash results immediately while idle", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.execution.executeBash("echo hi", undefined, {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("hi"));
					return { exitCode: 0 };
				},
			},
		});

		expect(harness.session.execution.hasPendingBashMessages).toBe(false);
		expect(harness.session.execution.messages[harness.session.execution.messages.length - 1]?.role).toBe(
			"bashExecution",
		);
		expect(getEntryTypes(harness)).toContain("message");
	});

	it("defers bash results while streaming and flushes them before the next prompt", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("after flush"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.execution.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const firstPrompt = harness.session.execution.prompt("start");
		await sawToolStart;
		await harness.session.execution.executeBash("echo hi", undefined, {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("hi"));
					return { exitCode: 0 };
				},
			},
		});

		expect(harness.session.execution.hasPendingBashMessages).toBe(true);
		expect(harness.session.execution.messages.some((message) => message.role === "bashExecution")).toBe(false);

		releaseToolExecution?.();
		await firstPrompt;

		expect(harness.session.execution.hasPendingBashMessages).toBe(false);
		expect(harness.session.execution.messages.some((message) => message.role === "bashExecution")).toBe(true);

		await harness.session.execution.prompt("next turn");

		expect(harness.session.execution.hasPendingBashMessages).toBe(false);
		expect(harness.session.execution.messages.some((message) => message.role === "bashExecution")).toBe(true);
		expect(getEntryTypes(harness).filter((type) => type === "message").length).toBeGreaterThan(0);
	});

	it("executes bash commands and records the result", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const result = await harness.session.execution.executeBash("printf 'hello'");

		expect(result.output).toContain("hello");
		expect(harness.session.execution.messages[harness.session.execution.messages.length - 1]?.role).toBe(
			"bashExecution",
		);
	});

	it("cancels running bash commands with abortBash", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				return await new Promise<{ exitCode: number | null }>((_resolve, reject) => {
					options.signal?.addEventListener(
						"abort",
						() => {
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				});
			},
		};

		const bashPromise = harness.session.execution.executeBash("sleep", undefined, { operations });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.execution.isBashRunning).toBe(true);
		harness.session.execution.abortBash();

		const result = await bashPromise;
		expect(result.cancelled).toBe(true);
		expect(harness.session.execution.isBashRunning).toBe(false);
	});

	it("keeps newer bash execution tracked when an older execution finishes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const invocations: ControlledBashInvocation[] = [];
		const operations = createControlledBashOperations(invocations);

		const firstBash = harness.session.execution.executeBash("first", undefined, { operations });
		const secondBash = harness.session.execution.executeBash("second", undefined, { operations });

		await vi.waitFor(() => expect(invocations).toHaveLength(2));
		invocations[0].finish();
		const firstResult = await firstBash;
		const runningAfterFirstSettles = harness.session.execution.isBashRunning;

		await vi.waitFor(() => expect(invocations).toHaveLength(2));
		harness.session.execution.abortBash();
		const secondWasAborted = invocations[1].signal?.aborted;
		invocations[1].finish();
		const secondResult = await secondBash;

		expect(firstResult.cancelled).toBe(false);
		expect(runningAfterFirstSettles).toBe(true);
		expect(secondWasAborted).toBe(true);
		expect(secondResult.cancelled).toBe(true);
		expect(harness.session.execution.isBashRunning).toBe(false);
	});

	it("aborts all active bash executions", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const invocations: ControlledBashInvocation[] = [];
		const operations = createControlledBashOperations(invocations);

		const firstBash = harness.session.execution.executeBash("first", undefined, { operations });
		const secondBash = harness.session.execution.executeBash("second", undefined, { operations });

		await vi.waitFor(() => expect(invocations).toHaveLength(2));
		harness.session.execution.abortBash();
		const abortedSignals = invocations.map((invocation) => invocation.signal?.aborted);
		for (const invocation of invocations) {
			invocation.finish();
		}
		const results = await Promise.all([firstBash, secondBash]);

		expect(abortedSignals).toEqual([true, true]);
		expect(results.map((result) => result.cancelled)).toEqual([true, true]);
		expect(harness.session.execution.isBashRunning).toBe(false);
	});

	it("waits for active bash work before session disposal resolves", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let started = () => {};
		const operationStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const bash = harness.session.execution.executeBash("sleep", undefined, {
			operations: {
				exec: async (_command, _cwd, options) => {
					started();
					return await new Promise<{ exitCode: number | null }>((resolve) => {
						options.signal?.addEventListener("abort", () => resolve({ exitCode: null }), { once: true });
					});
				},
			},
		});
		await operationStarted;

		await harness.session.execution.dispose();
		await bash;
		expect(harness.session.execution.isBashRunning).toBe(false);
	});

	it("persists user, assistant, toolResult, and custom messages in order", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.execution.sendCustomMessage({
			customType: "note",
			content: "hello",
			display: true,
			details: { a: 1 },
		});
		await harness.session.execution.prompt("start");

		const entries = harness.sessionManager.getEntries();
		expect(entries.map((entry) => entry.type)).toEqual([
			"model_change",
			"thinking_level_change",
			"custom_message",
			"message",
			"message",
			"message",
			"message",
			"message",
		]);
		expect(harness.session.execution.messages.map((message) => message.role)).toEqual([
			"custom",
			"system",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it("does not emit message_end for bash execution messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const messageEndRoles: string[] = [];
		harness.session.execution.subscribe((event) => {
			if (event.type === "message_end") {
				messageEndRoles.push(event.message.role);
			}
		});

		await harness.session.execution.executeBash("echo hi", undefined, {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("hi"));
					return { exitCode: 0 };
				},
			},
		});

		expect(messageEndRoles).toEqual([]);
	});

	it("persists aborted assistant messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.execution.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.execution.prompt("hi");
		await sawMessageUpdate;
		await harness.session.execution.abort();
		await promptPromise;

		const lastEntry = harness.sessionManager.getEntries()[harness.sessionManager.getEntries().length - 1];
		expect(lastEntry?.type).toBe("message");
		if (lastEntry?.type === "message") {
			expect(lastEntry.message.role).toBe("assistant");
			if (lastEntry.message.role === "assistant") {
				expect(lastEntry.message.stopReason).toBe("aborted");
			}
		}
	});

	it("records bash output through custom operations", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("hello from custom ops"));
				return { exitCode: 0 };
			},
		};

		const result = await harness.session.execution.executeBash("custom", undefined, { operations });

		expect(result.output).toContain("hello from custom ops");
		expect(harness.session.execution.messages[harness.session.execution.messages.length - 1]?.role).toBe(
			"bashExecution",
		);
	});

	it("streams bash output to the callback and session events", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const callbackDeltas: string[] = [];
		const eventUpdates: Array<{ id: string | undefined; delta: string }> = [];
		const unsubscribe = harness.session.execution.subscribe((event) => {
			if (event.type === "bash_execution_update") {
				eventUpdates.push({ id: event.id, delta: event.delta });
			}
		});
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("hello "));
				options.onData(Buffer.from("world"));
				return { exitCode: 0 };
			},
		};

		await harness.session.execution.executeBash("custom", (delta) => callbackDeltas.push(delta), {
			id: "bash-1",
			operations,
		});
		unsubscribe();

		expect(callbackDeltas).toEqual(["hello ", "world"]);
		expect(eventUpdates).toEqual([
			{ id: "bash-1", delta: "hello " },
			{ id: "bash-1", delta: "world" },
		]);
	});
});
