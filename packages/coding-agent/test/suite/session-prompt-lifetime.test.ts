import { fauxAssistantMessage, type TextContent } from "@candy/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";
import { useSummaryResponses } from "./summarization.ts";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("session prompt lifetime", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("rejects concurrent prompts during preflight without settling the accepted run", async () => {
		const hookStarted = deferred();
		const releaseHook = deferred();
		const responseStarted = deferred();
		const releaseResponse = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.on("before_agent_start", async () => {
						hookStarted.resolve();
						await releaseHook.promise;
						return { systemPrompt: "accepted prompt system text" };
					});
				},
			],
		});
		harnesses.push(harness);
		let requestSystemPrompt: string | TextContent[] | undefined;
		harness.setResponses([
			async (context) => {
				requestSystemPrompt = context.messages.find((message) => message.role === "system")?.content;
				responseStarted.resolve();
				await releaseResponse.promise;
				return fauxAssistantMessage("done");
			},
		]);
		const first = harness.session.execution.prompt("first");
		await hookStarted.promise;
		try {
			await expect(harness.session.execution.prompt("second")).rejects.toThrow("Agent is already processing");
			expect(harness.session.execution.isStreaming).toBe(true);
			expect(harness.session.execution.isIdle).toBe(false);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(0);
			releaseHook.resolve();
			await responseStarted.promise;
			expect(harness.session.execution.isStreaming).toBe(true);
			expect(requestSystemPrompt).toBe("accepted prompt system text");
			expect(harness.session.execution.systemPrompt).toBe("accepted prompt system text");
		} finally {
			releaseHook.resolve();
			releaseResponse.resolve();
		}
		await first;
		expect(getUserTexts(harness)).toEqual(["first"]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it.each(["input", "before_agent_start"] as const)(
		"aborts while an asynchronous %s hook is pending",
		async (event) => {
			const hookStarted = deferred();
			const releaseHook = deferred();
			const harness = await createHarness({
				extensionFactories: [
					(candy) => {
						const handler = async () => {
							hookStarted.resolve();
							await releaseHook.promise;
						};
						if (event === "input") candy.on("input", handler);
						else candy.on("before_agent_start", handler);
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("must not be requested")]);
			const prompt = harness.session.execution.prompt("cancelled input");
			const cancelled = expect(prompt).rejects.toMatchObject({ name: "AbortError" });
			await hookStarted.promise;
			try {
				await harness.session.execution.abort();
				expect(harness.session.execution.isIdle).toBe(true);
			} finally {
				releaseHook.resolve();
			}
			await cancelled;
			expect(harness.faux.state.callCount).toBe(0);
			expect(getUserTexts(harness)).toEqual([]);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(0);
		},
	);

	it("delivers and settles input accepted during automatic compaction", async () => {
		const compactionStarted = deferred();
		const releaseCompaction = deferred();
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		useSummaryResponses(harness, [
			async () => {
				compactionStarted.resolve();
				await releaseCompaction.promise;
				return fauxAssistantMessage("compacted history");
			},
		]);
		harness.setResponses([fauxAssistantMessage("initial response"), fauxAssistantMessage("queued response")]);
		const first = harness.session.execution.prompt("x".repeat(5000));
		await compactionStarted.promise;
		const queued = harness.session.execution.prompt("accepted during compaction");
		expect(harness.session.execution.pendingMessageCount).toBe(1);
		releaseCompaction.resolve();
		await Promise.all([first, queued]);
		expect(harness.session.execution.isIdle).toBe(true);
		expect(harness.session.execution.pendingMessageCount).toBe(0);
		expect(getUserTexts(harness)).toContain("accepted during compaction");
		expect(harness.faux.state.callCount).toBe(2);
	});
});
