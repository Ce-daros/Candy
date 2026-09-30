import { type AssistantMessage, fauxAssistantMessage } from "@candy/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function seedCompactableSession(harness: Harness): void {
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "x".repeat(500) }],
		timestamp: 1,
	});
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("y".repeat(200), { timestamp: 2 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	harness.sessionManager.appendMessage(assistant);
}

function runAutoCompaction(harness: Harness): Promise<boolean> {
	return (harness.session.execution as unknown as SessionWithCompactionInternals)._runAutoCompaction(
		"threshold",
		false,
	);
}

describe("automatic compaction cancellation regressions", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	// Regression test for #9340.
	it("does not start post-run auto-compaction after abort", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 200, maxTokens: 50 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 50, keepRecentTokens: 1 },
				retry: { enabled: false },
			},
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic network failure" }),
		]);
		harness.session.execution.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				harness.session.execution.abortCompaction();
				void harness.session.execution.abort();
			}
		});

		await harness.session.execution.prompt("z".repeat(1000));

		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	// Regression test for #9777.
	it("cancels summarization authentication", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedCompactableSession(harness);
		let markAuthStarted = () => {};
		const authStarted = new Promise<void>((resolve) => {
			markAuthStarted = resolve;
		});
		let authSignal: AbortSignal | undefined;
		vi.spyOn(harness.modelRuntime, "getAuth").mockImplementation(async (_model, options) => {
			authSignal = options?.signal;
			markAuthStarted();
			if (!authSignal) throw new Error("Missing auth abort signal");
			return await new Promise<never>((_resolve, reject) => {
				authSignal?.addEventListener("abort", () => reject(authSignal?.reason), { once: true });
			});
		});

		const compaction = runAutoCompaction(harness);
		await authStarted;
		const started = harness.eventsOfType("compaction_start").length;
		const wasCompacting = harness.session.execution.isCompacting;
		await Promise.all([compaction, harness.session.execution.abort()]);

		expect({ started, wasCompacting, authAborted: authSignal?.aborted }).toEqual({
			started: 1,
			wasCompacting: true,
			authAborted: true,
		});
		expect(harness.eventsOfType("compaction_end").at(-1)?.aborted).toBe(true);
	});

	// Regression test for #9777.
	it("cancels synchronously from compaction_start", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.session.execution.subscribe((event) => {
			if (event.type === "compaction_start") harness.session.execution.abortCompaction();
		});

		await runAutoCompaction(harness);

		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("compaction_end").at(-1)?.aborted).toBe(true);
	});

	// Regression test for #9777.
	it.each([
		["matching error text", () => new Error("Compaction cancelled")],
		["an unrelated AbortError", () => Object.assign(new Error("auth failed"), { name: "AbortError" })],
	] as const)("reports %s as a failure", async (_label, createError) => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedCompactableSession(harness);
		vi.spyOn(harness.modelRuntime, "getAuth").mockRejectedValue(createError());

		await runAutoCompaction(harness);

		const event = harness.eventsOfType("compaction_end").at(-1);
		expect(event?.aborted).toBe(false);
		expect(event?.errorMessage).toContain(createError().message);
	});
});
