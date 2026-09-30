import { fauxAssistantMessage } from "@candy/ai";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptDisposition } from "../../../src/core/agent-session.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";
import { useSummaryResponses } from "../summarization.ts";

describe("issue #7150: RPC prompt during manual compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("rejects an RPC prompt while manual compaction is in progress", async () => {
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
		harnesses.push(harness);
		useSummaryResponses(harness, [
			async () => {
				markCompactionStarted();
				await compactionReleased;
				return fauxAssistantMessage("manual compacted");
			},
			fauxAssistantMessage("manual compacted"),
		]);

		const timestamp = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old user message" }],
			timestamp: timestamp - 1000,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("old assistant response", { timestamp: timestamp - 500 }),
			usage: {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		harness.setResponses([fauxAssistantMessage("probe response")]);

		const compactPromise = harness.session.execution.compact();
		await compactionStarted;

		let preflightResult: PromptDisposition | undefined;
		let promptError: unknown;
		try {
			await harness.session.execution.prompt("PROBE-7150", {
				source: "rpc",
				preflightResult: (result) => {
					preflightResult = result;
				},
			});
		} catch (error) {
			promptError = error;
		} finally {
			releaseCompaction();
			await compactPromise;
		}

		const persistedUserTexts = harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
			);

		expect(preflightResult).toBeUndefined();
		expect(promptError).toEqual(
			expect.objectContaining({ message: expect.stringContaining("compaction is in progress") }),
		);
		expect(getUserTexts(harness)).not.toContain("PROBE-7150");
		expect(persistedUserTexts).not.toContain("PROBE-7150");
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(0);
	});
});
