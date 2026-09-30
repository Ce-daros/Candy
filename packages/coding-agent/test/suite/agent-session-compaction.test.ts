import type { AgentMessage, AgentTool } from "@candy/agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@candy/ai";
import type { FauxResponseFactory } from "@candy/ai/providers/faux";
import { estimateMessageTokens } from "@candy/ai/utils/estimate";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTestAgent } from "../execution-internals.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";
import { useSummaryResponses } from "./summarization.ts";

type SessionWithCompactionInternals = {
	_checkCompaction: (
		assistantMessage: AssistantMessage,
		skipAbortedCheck?: boolean,
		assistantEntryId?: string,
		toolResultEntryIds?: readonly string[],
	) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function useSummaryStreamFn(
	harness: Harness,
	summary: string,
	onRequest?: (context: TranscriptContext, options: SimpleStreamOptions | undefined) => void,
): () => number {
	const response: FauxResponseFactory = (context, options, _state, model) => {
		onRequest?.(context, options);
		return {
			...fauxAssistantMessage(summary),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(10),
		};
	};
	const provider = useSummaryResponses(
		harness,
		Array.from({ length: 4 }, () => response),
	);
	return () => provider.state.callCount;
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
}

async function createAbortableCompactionHarness(): Promise<{
	harness: Harness;
	compactionStarted: Promise<void>;
	releaseCompaction: () => void;
}> {
	let markCompactionStarted = () => {};
	const compactionStarted = new Promise<void>((resolve) => {
		markCompactionStarted = resolve;
	});
	let releaseCompaction = () => {};
	const compactionReleased = new Promise<void>((resolve) => {
		releaseCompaction = resolve;
	});
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
	});
	seedCompactableSession(harness);
	useSummaryResponses(harness, [
		async () => {
			markCompactionStarted();
			await compactionReleased;
			return fauxAssistantMessage("compacted");
		},
	]);
	return { harness, compactionStarted, releaseCompaction };
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts with a provider-generated summary", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		useSummaryStreamFn(harness, "summary from faux provider");

		await harness.session.execution.prompt("one");
		await harness.session.execution.prompt("two");
		const statsBefore = harness.session.history.getSessionStats(harness.session.selection.model);

		const result = await harness.session.execution.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const estimatedTokensAfter = harness.session.execution.messages.reduce(
			(sum, message) => sum + estimateMessageTokens(message),
			0,
		);
		if (!result.usage) throw new Error("expected compaction usage");
		const summaryUsage = result.usage;

		expect(result.summary).toBe("summary from faux provider");
		expect(result.usage).toEqual(summaryUsage);
		expect(result.estimatedTokensAfter).toBe(estimatedTokensAfter);
		expect(compactionEntries).toHaveLength(1);
		const compactionEntry = compactionEntries[0];
		if (compactionEntry?.type === "compaction") {
			expect(compactionEntry.usage).toEqual(summaryUsage);
		}
		const statsAfter = harness.session.history.getSessionStats(harness.session.selection.model);
		expect(statsAfter.tokens.input).toBe(statsBefore.tokens.input + summaryUsage.input);
		expect(statsAfter.tokens.output).toBe(statsBefore.tokens.output + summaryUsage.output);
		expect(statsAfter.tokens.cacheRead).toBe(statsBefore.tokens.cacheRead + summaryUsage.cacheRead);
		expect(statsAfter.tokens.cacheWrite).toBe(statsBefore.tokens.cacheWrite + summaryUsage.cacheWrite);
		expect(statsAfter.cost).toBe(statsBefore.cost + summaryUsage.cost.total);
		expect(harness.session.execution.messages[0]?.role).toBe("system");
		expect(harness.session.execution.messages[1]?.role).toBe("compactionSummary");
	});

	it("checkpoints the replayed system state and folds summarized and retained system patches into it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("declared")]);
		await harness.session.execution.prompt("declare the prompt");
		const declared = harness.session.execution.messages[0];
		if (declared?.role !== "system") throw new Error("expected declared system message");

		harness.sessionManager.appendMessage({
			role: "system",
			content: "summarized instruction",
			sections: { early: "<early>1</early>" },
			toolsRemoved: [{ name: "bash" }],
			timestamp: Date.now(),
		});
		const firstKeptEntryId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept before patch" }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage({
			role: "system",
			content: "retained instruction",
			sections: { extra: "<extra>late</extra>" },
			toolsRemoved: [{ name: "read" }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept after patch" }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendCompaction("compacted", firstKeptEntryId, 100);

		const messages = harness.sessionManager.buildSessionContext().messages;
		expect(messages.map((message) => message.role)).toEqual(["system", "compactionSummary", "user", "user"]);
		const checkpoint = messages[0];
		if (checkpoint?.role !== "system") throw new Error("expected checkpoint system message");
		expect(checkpoint.content).toBe("summarized instruction\n\nretained instruction");
		expect(checkpoint.sections).toEqual({
			...declared.sections,
			early: "<early>1</early>",
			extra: "<extra>late</extra>",
		});
		expect(checkpoint.toolsAdded?.map((tool) => tool.name)).toEqual(
			harness.session.execution.getActiveToolNames().filter((name) => name !== "read" && name !== "bash"),
		);
	});

	it("allows a queued prompt to start when manual compaction ends", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "manual compacted");
		harness.setResponses([fauxAssistantMessage("queued response")]);

		let queuedPrompt: Promise<void> | undefined;
		harness.session.execution.subscribe((event) => {
			if (event.type === "compaction_end" && event.reason === "manual" && event.result) {
				expect(harness.session.execution.isCompacting).toBe(false);
				queuedPrompt = harness.session.execution.prompt("queued after compaction");
			}
		});

		await harness.session.execution.compact();
		if (!queuedPrompt) throw new Error("compaction_end did not start the queued prompt");
		await queuedPrompt;

		expect(getUserTexts(harness)).toContain("queued after compaction");
		expect(harness.session.history.getLastAssistantText()).toBe("queued response");
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.selection.clearModel();

		await expect(harness.session.execution.compact()).rejects.toThrow("No model selected");
	});

	it("rejects manual compaction when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "summary from custom stream");

		await expect(harness.session.execution.compact()).rejects.toThrow("No API key found for faux");
	});

	it("manually compacts with provider-resolved bearer auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const model = harness.getModel();
		harness.session.execution.modelRuntime.registerNativeProvider({
			id: model.provider,
			name: "Faux bearer provider",
			auth: {
				apiKey: {
					name: "Faux bearer token",
					resolve: async () => ({
						auth: { headers: { Authorization: "Bearer ambient-token" } },
						source: "ambient bearer token",
					}),
				},
			},
			getModels: () => harness.models,
			stream: () => createAssistantMessageEventStream(),
			streamSimple: () => createAssistantMessageEventStream(),
		});
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary with bearer auth", (_context, options) => {
			expect(options?.apiKey).toBeUndefined();
			expect(options?.headers).toEqual({ Authorization: "Bearer ambient-token" });
		});

		const result = await harness.session.execution.compact();

		expect(result.summary).toContain("summary with bearer auth");
		expect(getStreamCallCount()).toBe(1);
	});

	it("uses the standalone compaction request context", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedCompactableSession(harness);

		const transformContext = vi.fn(async (messages: AgentMessage[]) => messages);
		getTestAgent(harness.session.execution).transformContext = transformContext;
		getTestAgent(harness.session.execution).sessionId = "active-routing-session";
		getTestAgent(harness.session.execution).transport = "websocket";

		let requestContext: TranscriptContext | undefined;
		let requestOptions: SimpleStreamOptions | undefined;
		useSummaryStreamFn(harness, "standalone summary", (context, options) => {
			requestContext = context;
			requestOptions = options;
		});

		await harness.session.execution.compact();

		expect(transformContext).not.toHaveBeenCalled();
		expect(getCurrentSystemPrompt(requestContext?.messages ?? [])).not.toBe(
			getTestAgent(harness.session.execution).state.systemPrompt,
		);
		expect(getCurrentTools(requestContext?.messages ?? [])).toEqual([]);
		// Regression test for #9652: split-turn summaries use a clear Markdown conversation boundary.
		expect(JSON.stringify(requestContext?.messages)).toContain("# Conversation\\n[User]: message to compact");
		expect(requestOptions).toMatchObject({ cacheRetention: "none" });
		expect(requestOptions?.sessionId).not.toBe("active-routing-session");
		expect(requestOptions?.transport).toBeUndefined();
	});

	it("persists usage from pi-generated manual compaction", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.execution.compact();

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		if (!result.usage) throw new Error("expected compaction usage");
		expect(result.usage.totalTokens).toBeGreaterThan(0);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]?.type === "compaction" ? compactionEntries[0].usage : undefined).toEqual(
			result.usage,
		);
	});

	it("reports missing auth from automatic compaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "auto summary from custom stream");
		const sessionInternals = harness.session.execution as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEntries).toHaveLength(0);
		expect(compactionEnd?.errorMessage).toContain("No API key found for faux");
	});

	it("reports failures from automatic compaction", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedCompactableSession(harness);
		getTestAgent(harness.session.execution).streamFunction = () => {
			throw new Error("summary generator blew up");
		};
		const sessionInternals = harness.session.execution as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
			errorMessage: "Auto-compaction failed: summary generator blew up",
		});
	});

	it("compacts and resumes after a length stop below the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		useSummaryStreamFn(harness, "overflow compacted");
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			fauxAssistantMessage("completed response"),
		]);

		await harness.session.execution.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		expect(harness.session.history.getLastAssistantText()).toBe("completed response");
	});

	// Regression coverage for #8133: model overrides must also apply between assistant turns.
	// Regression coverage for #9740: an oversized trailing tool result must still produce a cut point.
	it.each([false, true])(
		"compacts after an oversized tool result in the same run (model override: %s)",
		async (modelOverride) => {
			const toolResult = `large-tool-result:${"x".repeat(8000)}`;
			const largeTool: AgentTool = {
				name: "large_result",
				label: "Large result",
				description: "Returns enough content to cross the compaction threshold",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: toolResult }], details: {} }),
			};
			const order: string[] = [];
			const observedReserveTokens: number[] = [];
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
				settings: {
					compaction: modelOverride
						? {
								enabled: true,
								reserveTokens: 0,
								keepRecentTokens: 20000,
								modelOverrides: { "faux/faux-1": { reserveTokens: 400, keepRecentTokens: 1750 } },
							}
						: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 },
				},
				tools: [largeTool],
			});
			harnesses.push(harness);
			useSummaryResponses(harness, [
				(_context, options) => {
					order.push("compaction");
					observedReserveTokens.push(options?.maxTokens ?? 0);
					return fauxAssistantMessage("compacted history");
				},
				fauxAssistantMessage("compacted history"),
			]);
			let resumedRequest = "";
			harness.setResponses([
				fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
				fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
				fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
				(context) => {
					order.push("provider");
					resumedRequest = JSON.stringify(context.messages);
					return fauxAssistantMessage("finished after compaction");
				},
			]);

			await harness.session.execution.prompt("seed old history");
			await harness.session.execution.prompt("seed recent history");
			const agentStartsBefore = harness.eventsOfType("agent_start").length;
			await harness.session.execution.prompt("run the large tool");

			expect(order.slice(0, 2)).toEqual(["compaction", "provider"]);
			expect(observedReserveTokens[0]).toBe(100);
			expect(harness.eventsOfType("agent_start")).toHaveLength(agentStartsBefore + 1);
			expect(harness.eventsOfType("compaction_start").at(-1)).toEqual({
				type: "compaction_start",
				reason: "threshold",
			});
			expect(resumedRequest).toContain("compacted history");
			expect(resumedRequest).toContain("large-tool-result");
			expect(harness.session.history.getLastAssistantText()).toBe("finished after compaction");
		},
	);

	it("includes steering queued during compaction in the resumed assistant request", async () => {
		const largeTool: AgentTool = {
			name: "large_result",
			label: "Large result",
			description: "Returns enough content to cross the compaction threshold",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `large-tool-result:${"x".repeat(6800)}` }],
				details: {},
			}),
		};
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [largeTool],
		});
		harnesses.push(harness);
		useSummaryResponses(harness, [
			async () => {
				markCompactionStarted();
				await compactionReleased;
				return fauxAssistantMessage("compacted history");
			},
			fauxAssistantMessage("compacted history"),
		]);
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("finished after compaction");
			},
			fauxAssistantMessage("finished after delayed steering"),
		]);

		await harness.session.execution.prompt("seed old history");
		await harness.session.execution.prompt("seed recent history");
		const promptPromise = harness.session.execution.prompt("run the large tool");
		await compactionStarted;
		await harness.session.execution.steer("change direction");
		releaseCompaction();
		await promptPromise;

		expect(resumedRequest).toContain("change direction");
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("does not compact after a terminating tool result", async () => {
		const terminatingTool: AgentTool = {
			name: "terminate_with_large_result",
			label: "Terminate with large result",
			description: "Returns enough content to cross the compaction threshold, then terminates",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `large-tool-result:${"x".repeat(6800)}` }],
				details: {},
				terminate: true,
			}),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [terminatingTool],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("terminate_with_large_result", {}), { stopReason: "toolUse" }),
		]);

		await harness.session.execution.prompt("seed old history");
		await harness.session.execution.prompt("seed recent history");
		await harness.session.execution.prompt("run the terminating tool");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not compact when a length stop reaches the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(400), { stopReason: "length" })]);

		await harness.session.execution.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("stops after one compact-and-retry when a second response is also truncated", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		useSummaryStreamFn(harness, "overflow compacted");
		harness.setResponses([
			() => fauxAssistantMessage("x".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
			() => fauxAssistantMessage("y".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
		]);

		await harness.session.execution.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_start").filter((event) => event.reason === "overflow")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toBe(
			"Truncated response recovery failed after one compact-and-retry attempt.",
		);
	});

	it("keeps overflow wording when a repeated length stop fills the context window", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session.execution as unknown as SessionWithCompactionInternals;
		const lengthOverflowMessage = createAssistant(harness, {
			stopReason: "length",
			totalTokens: 100,
			timestamp: Date.now(),
		});
		const firstEntryId = harness.sessionManager.appendMessage(lengthOverflowMessage);
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.execution.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(lengthOverflowMessage, true, firstEntryId);
		const repeatedLengthMessage = { ...lengthOverflowMessage, timestamp: Date.now() + 1 };
		const repeatedEntryId = harness.sessionManager.appendMessage(repeatedLengthMessage);
		await sessionInternals._checkCompaction(repeatedLengthMessage, true, repeatedEntryId);

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const { harness, compactionStarted, releaseCompaction } = await createAbortableCompactionHarness();
		harnesses.push(harness);

		const compactPromise = harness.session.execution.compact();
		const compactExpectation = expect(compactPromise).rejects.toThrow("Compaction cancelled");
		await compactionStarted;
		harness.session.execution.abortCompaction();
		releaseCompaction();

		await compactExpectation;
	});

	// Regression test for #8920.
	it("aborts an in-progress manual compaction and waits until the session is idle", async () => {
		const { harness, compactionStarted, releaseCompaction } = await createAbortableCompactionHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("continued")]);

		const compactPromise = harness.session.execution.compact();
		const compactExpectation = expect(compactPromise).rejects.toThrow("Compaction cancelled");
		await compactionStarted;
		const abortPromise = harness.session.execution.abort();
		releaseCompaction();
		await abortPromise;
		await compactExpectation;

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "manual",
			aborted: true,
		});
		expect(harness.session.execution.isCompacting).toBe(false);
		expect(harness.session.execution.isIdle).toBe(true);

		await expect(harness.session.execution.prompt("next prompt")).resolves.toBeUndefined();
		expect(harness.session.history.getLastAssistantText()).toBe("continued");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		useSummaryResponses(harness, [
			async () => {
				markCompactionStarted();
				await compactionReleased;
				return fauxAssistantMessage("auto compacted");
			},
			fauxAssistantMessage("auto compacted"),
		]);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.execution.prompt("first");
		await harness.session.execution.prompt("second");

		const sessionInternals = harness.session.execution as unknown as SessionWithCompactionInternals;
		const autoCompaction = sessionInternals._runAutoCompaction("threshold", false);
		await compactionStarted;
		await harness.session.execution.followUp("queued follow-up");
		releaseCompaction();
		await expect(autoCompaction).resolves.toBe(true);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session.execution as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const firstEntryId = harness.sessionManager.appendMessage(overflowMessage);
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.execution.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage, true, firstEntryId);
		const repeatedOverflowMessage = { ...overflowMessage, timestamp: Date.now() + 1 };
		const repeatedEntryId = harness.sessionManager.appendMessage(repeatedOverflowMessage);
		await sessionInternals._checkCompaction(repeatedOverflowMessage, true, repeatedEntryId);

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("compacts successful overflow responses without retrying", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
		});
		harnesses.push(harness);
		useSummaryStreamFn(harness, "successful overflow compacted");
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await expect(harness.session.execution.prompt("hello")).resolves.toBeUndefined();

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session.execution as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session.execution as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now() - 1000,
		});
		harness.sessionManager.appendMessage(successfulAssistant);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "retry" }],
			timestamp: Date.now() + 500,
		});
		harness.sessionManager.appendMessage(errorAssistant);

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session.execution as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now() - 1000,
		});
		harness.sessionManager.appendMessage(errorAssistant);

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session.execution as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "new prompt" }],
			timestamp: Date.now() - 500,
		});
		harness.sessionManager.appendMessage(errorAssistant);

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session
			.execution as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session.execution as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});
});
