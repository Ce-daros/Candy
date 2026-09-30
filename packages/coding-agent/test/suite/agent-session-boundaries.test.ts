import type { AgentTool } from "@candy/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@candy/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { useSummaryResponses } from "./summarization.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("turn_end committed boundaries", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});
	it("commits each handler before the next reads history and continues exactly once", async () => {
		const order: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.on("turn_end", (event) => {
						if (event.turnIndex > 0) return;
						order.push("first");
						return {
							entries: [
								{ type: "custom", customType: "progress", data: 1 },
								{ type: "custom_message", customType: "next", content: "continue work", display: false },
							],
							continue: true,
						};
					});
				},
				(candy) => {
					candy.on("turn_end", (event, ctx) => {
						if (event.turnIndex > 0) return;
						expect(
							ctx.history
								.getEntries()
								.some((entry) => entry.type === "custom" && entry.customType === "progress"),
						).toBe(true);
						expect(JSON.stringify(event.context.contextMessages)).toContain("continue work");
						expect(event.entries).toHaveLength(2);
						order.push("second");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("continue work");
				return fauxAssistantMessage("second");
			},
		]);
		await harness.session.execution.prompt("start");
		expect(order).toEqual(["first", "second"]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		const assistantEntries = harness.session.history
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		expect(assistantEntries).toHaveLength(2);
	});
	it("publishes canonical context before notifying appended entries", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.on("turn_end", () => ({
						entries: [
							{ type: "custom", customType: "metadata", data: true },
							{ type: "custom_message", customType: "context", content: "committed context", display: true },
						],
					}));
				},
			],
		});
		harnesses.push(harness);
		const snapshots: string[] = [];
		harness.session.execution.subscribe((event) => {
			if (event.type === "entry_appended") snapshots.push(JSON.stringify(harness.session.execution.messages));
		});
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.execution.prompt("start");
		expect(snapshots).toHaveLength(2);
		expect(snapshots.every((value) => value.includes("committed context"))).toBe(true);
	});
	it.each(["steer", "followUp"] as const)("merges an extension continuation with %s input", async (deliverAs) => {
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.on("turn_end", (event) => {
						if (event.turnIndex > 0) return;
						candy.sendUserMessage("queued work", { deliverAs });
						return {
							entries: [
								{ type: "custom_message", customType: "context", content: "boundary context", display: false },
							],
							continue: true,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("queued work");
				expect(JSON.stringify(context.messages)).toContain("boundary context");
				return fauxAssistantMessage("second");
			},
		]);
		await harness.session.execution.prompt("start");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.execution.pendingMessageCount).toBe(0);
	});
	it("commits intercepted tool results once before handlers and consumers see them", async () => {
		const tool: AgentTool = {
			name: "read_test",
			label: "read_test",
			description: "read",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "raw" }], details: {} }),
		};
		const observations: string[] = [];
		const harness = await createHarness({
			tools: [tool],
			extensionFactories: [
				(candy) => {
					candy.on("tool_result", () => ({ content: [{ type: "text", text: "processed" }] }));
					candy.on("turn_end", (event, ctx) => {
						if (event.turnIndex > 0) return;
						expect(getMessageText(event.toolResults[0])).toBe("processed");
						expect(event.toolResultEntryIds).toHaveLength(1);
						expect(ctx.history.getEntry(event.toolResultEntryIds[0])?.type).toBe("message");
						return {
							entries: [{ type: "custom_message", customType: "next", content: "next work", display: false }],
							continue: true,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.execution.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "toolResult")
				observations.push(getMessageText(event.message));
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read_test", {}, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.execution.prompt("start");
		expect(observations).toEqual(["processed"]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(
			harness.session.history
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
		).toHaveLength(1);
	});
	it("rejects continuation without runnable context and keeps the committed response", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.on("turn_end", () => ({ continue: true }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await expect(harness.session.execution.prompt("start")).rejects.toThrow("without runnable model context");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(
			harness.session.history
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
		).toHaveLength(1);
	});
	it("stops after handler failure and reports final settlement once", async () => {
		const later = vi.fn();
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.on("turn_end", () => {
						throw new Error("boundary failed");
					});
					candy.on("turn_end", later);
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await expect(harness.session.execution.prompt("start")).rejects.toThrow("boundary failed");
		expect(later).not.toHaveBeenCalled();
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});
	it.each(["error", "aborted"] as const)("ignores extension continuation after %s", async (stopReason) => {
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(candy) => {
					candy.on("turn_end", () => ({
						entries: [{ type: "custom_message", customType: "context", content: "next work", display: false }],
						continue: true,
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("failed", { stopReason, errorMessage: stopReason })]);
		await harness.session.execution.prompt("start");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});
	it("invalidates continuation when cancelled during a boundary", async () => {
		const started = deferred(),
			released = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.on("turn_end", async () => {
						started.resolve();
						await released.promise;
						return {
							entries: [{ type: "custom_message", customType: "context", content: "next work", display: false }],
							continue: true,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const prompt = harness.session.execution.prompt("start");
		await started.promise;
		const abort = harness.session.execution.abort();
		released.resolve();
		await Promise.all([prompt, abort]);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});
	it("rejects continuation when a context edit leaves an orphan tool result", async () => {
		const tool: AgentTool = {
			name: "read_test",
			label: "read_test",
			description: "read",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "result" }], details: {} }),
		};
		const harness = await createHarness({
			tools: [tool],
			extensionFactories: [
				(candy) => {
					candy.on("turn_end", (event) => ({
						entries: [{ type: "context_edit", targetId: event.messageEntryId, replacement: null }],
						continue: true,
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("read_test", {}), { stopReason: "toolUse" })]);
		await expect(harness.session.execution.prompt("start")).rejects.toThrow("without runnable model context");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});
	it("validates an entire handler's additions before committing any of them", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.on("turn_end", () => ({
						entries: [
							{ type: "custom", customType: "uncommitted", data: true },
							{ type: "context_edit", targetId: "missing-entry", replacement: null },
						],
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await expect(harness.session.execution.prompt("start")).rejects.toThrow();
		expect(
			harness.session.history
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "uncommitted"),
		).toBe(false);
		expect(harness.eventsOfType("entry_appended")).toHaveLength(0);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});
});

describe("durable length recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("keeps truncated tool attempts in context for the natural next turn", async () => {
		let executed = false;
		const requests: string[] = [];
		const tool: AgentTool = {
			name: "unsafe_truncated_tool",
			label: "Unsafe truncated tool",
			description: "Must not execute from a length response",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => {
				executed = true;
				return { content: [{ type: "text", text: "executed" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("unsafe_truncated_tool", { value: "partial" }), {
				stopReason: "length",
			}),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("completed natural continuation");
			},
		]);

		await harness.session.execution.prompt("start");

		expect(executed).toBe(false);
		expect(harness.faux.state.callCount).toBe(2);
		expect(requests[0]).toContain("may be truncated");
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "context_edit")).toBe(false);
	});

	it("resets length recovery after a successful intermediate assistant turn", async () => {
		const tool: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			tools: [tool],
		});
		harnesses.push(harness);
		useSummaryResponses(
			harness,
			Array.from({ length: 4 }, () => fauxAssistantMessage("recovered overflow")),
		);
		harness.setResponses([
			fauxAssistantMessage("first partial", { stopReason: "length" }),
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("second partial", { stopReason: "length", timestamp: Date.now() + 1_000 }),
			() => fauxAssistantMessage("completed second recovery", { timestamp: Date.now() + 2_000 }),
		]);

		await harness.session.execution.prompt("x".repeat(5000));

		const omittedIds = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "context_edit")
			.map((entry) => entry.targetId);
		const lengthResponses = harness.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "length",
			);
		expect(lengthResponses).toHaveLength(2);
		expect(omittedIds).toEqual(expect.arrayContaining(lengthResponses.map((entry) => entry.id)));
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("gives a distinct queued follow-up its own length-recovery budget", async () => {
		let queued = false;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(candy) => {
					candy.on("agent_end", (event) => {
						if (queued || !event.messages.some((message) => getMessageText(message) === "first recovered"))
							return;
						queued = true;
						candy.sendUserMessage("distinct follow-up", { deliverAs: "followUp" });
					});
				},
			],
		});
		harnesses.push(harness);
		useSummaryResponses(
			harness,
			Array.from({ length: 4 }, () => fauxAssistantMessage("recovered overflow")),
		);
		harness.setResponses([
			fauxAssistantMessage("first partial", { stopReason: "length" }),
			fauxAssistantMessage("first recovered"),
			() => fauxAssistantMessage("follow-up partial", { stopReason: "length", timestamp: Date.now() + 1_000 }),
			() => fauxAssistantMessage("follow-up recovered", { timestamp: Date.now() + 2_000 }),
		]);

		await harness.session.execution.prompt("x".repeat(5000));

		const lengthIds = harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "length"
					? [entry.id]
					: [],
			);
		const omitted = harness.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "context_edit" ? [entry.targetId] : []));
		expect(lengthIds).toHaveLength(2);
		expect(omitted).toEqual(expect.arrayContaining(lengthIds));
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("finishes retry bookkeeping when a retry receives a nonretryable error", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
		]);

		await harness.session.execution.prompt("start");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_end")).toContainEqual(
			expect.objectContaining({ success: false, attempt: 1, finalError: "invalid_api_key" }),
		);
	});

	it("omits a recoverable projected replacement by its source entry ID", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "x".repeat(5_000), timestamp: Date.now() - 2 });
		const partial = fauxAssistantMessage("original partial", {
			stopReason: "length",
			timestamp: Date.now() - 1,
		});
		const partialId = harness.sessionManager.appendMessage(partial);
		harness.sessionManager.appendContextEdit(partialId, {
			content: [{ type: "text", text: "edited partial" }],
		});
		harness.setResponses([fauxAssistantMessage("new answer")]);

		await harness.session.execution.prompt("next prompt");

		const edits = harness.sessionManager.getEntries().filter((entry) => entry.type === "context_edit");
		expect(edits.filter((entry) => entry.targetId === partialId).at(-1)?.replacement).toBeNull();
		expect(
			harness.sessionManager
				.buildSessionProjection()
				.messages.some((message) => getMessageText(message) === "edited partial"),
		).toBe(false);
	});

	it("recovers an explicit overflow error after a retained boundary replacement", async () => {
		let replaced = false;
		let overflowId: string | undefined;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(candy) => {
					candy.on("turn_end", (event) => {
						if (replaced || event.outcome !== "error") return;
						replaced = true;
						overflowId = event.messageEntryId;
						return {
							entries: [
								{
									type: "context_edit",
									targetId: event.messageEntryId,
									replacement: { content: [{ type: "text", text: "retained error" }] },
								},
							],
						};
					});
				},
			],
		});
		harnesses.push(harness);
		useSummaryResponses(
			harness,
			Array.from({ length: 4 }, () => fauxAssistantMessage("recovered overflow")),
		);
		harness.setResponses([
			fauxAssistantMessage("retained error", { stopReason: "error", errorMessage: "prompt is too long" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.execution.prompt("x".repeat(5_000));

		expect(harness.faux.state.callCount).toBe(2);
		expect(overflowId).toBeDefined();
		const edits = harness.sessionManager.getEntries().filter((entry) => entry.type === "context_edit");
		expect(edits.filter((entry) => entry.targetId === overflowId).at(-1)?.replacement).toBeNull();
	});

	it("keeps follow-up work behind an automatic error retry", async () => {
		let queued = false;
		const requests: string[] = [];
		const lifecycle: string[] = [];
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			extensionFactories: [
				(candy) => {
					candy.on("turn_end", (event) => {
						if (queued || event.outcome !== "error") return;
						queued = true;
						candy.sendUserMessage("queued follow-up", { deliverAs: "followUp" });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.execution.subscribe((event) => {
			if (event.type === "agent_end" || event.type === "auto_retry_start") lifecycle.push(event.type);
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("retry recovered");
			},
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("follow-up completed");
			},
		]);

		await harness.session.execution.prompt("start");

		expect(harness.faux.state.callCount).toBe(3);
		expect(requests[0]).not.toContain("queued follow-up");
		expect(requests[1]).toContain("queued follow-up");
		expect(lifecycle.slice(0, 2)).toEqual(["agent_end", "auto_retry_start"]);
	});

	it("marks the exhausted retry run as final", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);

		await harness.session.execution.prompt("start");

		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(harness.eventsOfType("auto_retry_end")).toContainEqual(
			expect.objectContaining({ success: false, attempt: 1 }),
		);
	});

	it("keeps omissions and does not retry when recovery compaction fails", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: {
				compaction: { keepRecentTokens: 1, reserveTokens: 0 },
				retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			fauxAssistantMessage("summary failed", { stopReason: "error", errorMessage: "summary failed" }),
			fauxAssistantMessage("must not retry"),
		]);

		await harness.session.execution.prompt("x".repeat(5000));

		const entries = harness.sessionManager.getEntries();
		expect(entries.some((entry) => entry.type === "context_edit")).toBe(true);
		expect(entries.some((entry) => entry.type === "compaction")).toBe(false);
		expect(
			entries.some((entry) => entry.type === "message" && getMessageText(entry.message) === "partial response"),
		).toBe(true);
		expect(
			harness.sessionManager
				.buildSessionProjection()
				.messages.some((message) => getMessageText(message) === "partial response"),
		).toBe(false);
		expect(harness.faux.state.callCount).toBe(2);
	});
});
