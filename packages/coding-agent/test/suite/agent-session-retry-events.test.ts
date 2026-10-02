import type { AgentTool } from "@candy/agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@candy/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function normalizeEventOrder(events: Harness["events"]): string[] {
	const normalized: string[] = [];
	for (const event of events) {
		const label =
			event.type === "message_start" || event.type === "message_end"
				? `${event.type}:${event.message.role}`
				: event.type === "tool_execution_start" || event.type === "tool_execution_end"
					? `${event.type}:${event.toolName}`
					: event.type;
		if (label === "message_update" && normalized[normalized.length - 1] === "message_update") {
			continue;
		}
		normalized.push(label);
	}
	return normalized;
}

describe("AgentSession retry and event characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("retries after a transient error and succeeds", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.execution.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.execution.prompt("test");

		expect(retryEvents).toEqual(["start:1", "end:true"]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.execution.isRetrying).toBe(false);
	});

	it("caps agent retry delay", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 5, baseDelayMs: 1, maxAgentDelayMs: 5 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			...Array.from({ length: 4 }, () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.execution.prompt("test");

		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([1, 2, 4, 5]);
	});

	it("retries provider network_error failures", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider finish_reason: network_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.execution.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true }]);
	});

	it("retries multiple transient failures and succeeds on the final attempt", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.execution.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("success"),
		]);

		await harness.session.execution.prompt("test");

		expect(retryEvents).toEqual(["start:1", "start:2", "end:true"]);
		expect(harness.faux.state.callCount).toBe(3);
	});

	// Regression test for #9340.
	it("finalizes retry state when abort is requested after a retry attempt fails", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);

		let errorCount = 0;
		harness.session.execution.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			if (event.message.stopReason === "error" && ++errorCount === 2) void harness.session.execution.abort();
		});

		await harness.session.execution.prompt("test");

		expect(harness.session.execution.retryAttempt).toBe(0);
		expect(harness.eventsOfType("agent_end").at(-1)?.willRetry).toBe(false);
		expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({
			success: false,
			attempt: 1,
			finalError: "Retry cancelled",
		});
	});

	it("exhausts max retries and emits a failure event", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } });
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.execution.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);

		await harness.session.execution.prompt("test");

		expect(retryEvents).toEqual(["start:1", "start:2", "end:false"]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, true, false]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.execution.isRetrying).toBe(false);
	});

	it("prompt waits for retry completion even when assistant message_end handling is delayed", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [
				(candy) => {
					candy.on("turn_end", async (event) => {
						if (event.message.role === "assistant") {
							await new Promise((resolve) => setTimeout(resolve, 40));
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.execution.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.execution.isRetrying).toBe(false);
	});

	it("does not retry when retry is disabled", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		await harness.session.execution.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("does not retry non-retryable errors", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

		await harness.session.execution.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("cancels retry sleep when abortRetry is called", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		const sawRetryStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.execution.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.execution.prompt("test");
		await sawRetryStart;
		harness.session.execution.abortRetry();
		await promptPromise;

		expect(harness.session.execution.isRetrying).toBe(false);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.finalError)).toContain("Retry cancelled");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("waits for the full loop when retry recovery produces tool calls", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer"),
		]);

		await harness.session.execution.prompt("test");

		expect(harness.faux.state.callCount).toBe(3);
		expect(toolRuns).toEqual(["hello"]);
		expect(harness.session.execution.isStreaming).toBe(false);
		await harness.session.execution.prompt("follow-up");
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("emits the expected event order for a single prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.execution.prompt("hi");

		expect(normalizeEventOrder(harness.events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:system",
			"message_end:system",
			"message_start:user",
			"message_end:user",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"turn_end",
			"agent_end",
			"agent_settled",
		]);
	});

	it("emits the expected event order for a tool call turn", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.execution.prompt("hi");

		expect(toolRuns).toEqual(["hello"]);
		expect(normalizeEventOrder(harness.events)).toEqual([
			"agent_start",
			"turn_start",
			"message_start:system",
			"message_end:system",
			"message_start:user",
			"message_end:user",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"tool_execution_start:echo",
			"tool_execution_end:echo",
			"message_start:toolResult",
			"message_end:toolResult",
			"turn_end",
			"turn_start",
			"message_start:assistant",
			"message_update",
			"message_end:assistant",
			"turn_end",
			"agent_end",
			"agent_settled",
		]);
	});

	it("emits streaming deltas for text, thinking, and tool calls in message_update events", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxThinking("plan"), { type: "text", text: "answer" }, fauxToolCall("echo", { text: "hello" })],
				{
					stopReason: "toolUse",
				},
			),
		]);

		await harness.session.execution.prompt("hi").catch(() => {});

		const updateTypes = harness.eventsOfType("message_update").map((event) => event.assistantMessageEvent.type);
		expect(updateTypes).toContain("thinking_delta");
		expect(updateTypes).toContain("text_delta");
		expect(updateTypes).toContain("toolcall_delta");
	});

	it("emits agent_end for error responses", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "broken" })]);

		await harness.session.execution.prompt("hi");

		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(harness.events[harness.events.length - 1]?.type).toBe("agent_settled");
	});

	it("emits agent_end for aborted runs and persists the aborted assistant message", async () => {
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

		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(harness.events[harness.events.length - 1]?.type).toBe("agent_settled");
		const lastMessage = harness.session.execution.messages[harness.session.execution.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.stopReason).toBe("aborted");
		}
	});
});
