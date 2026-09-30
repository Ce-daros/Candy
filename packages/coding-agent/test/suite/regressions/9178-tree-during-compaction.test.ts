import { fauxAssistantMessage } from "@candy/ai";
import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";
import { useSummaryResponses } from "../summarization.ts";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

describe("issue #9178: tree navigation during manual compaction", () => {
	let harness: Harness | undefined;

	afterEach(async () => await harness?.cleanup());

	it("rejects navigation before the active leaf can change", async () => {
		const compactionStarted = createDeferred();
		const compactionReleased = createDeferred();

		harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
		});

		harness.sessionManager.appendMessage(userMsg("first user"));
		const navigationTargetId = harness.sessionManager.appendMessage(assistantMsg("first assistant"));
		harness.sessionManager.appendMessage(userMsg("second user"));
		const originalLeafId = harness.sessionManager.appendMessage(assistantMsg("second assistant"));

		useSummaryResponses(harness, [
			async () => {
				compactionStarted.resolve();
				await compactionReleased.promise;
				return fauxAssistantMessage("summary");
			},
			fauxAssistantMessage("summary"),
		]);
		const compactionPromise = harness.session.execution.compact();
		await compactionStarted.promise;

		expect(harness.session.execution.isCompacting).toBe(true);
		try {
			await expect(harness.session.execution.navigateTree(navigationTargetId, { summarize: false })).rejects.toThrow(
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
			expect(harness.sessionManager.getLeafId()).toBe(originalLeafId);
		} finally {
			compactionReleased.resolve();
		}
		await compactionPromise;

		expect(harness.sessionManager.getEntries().at(-1)).toMatchObject({
			type: "compaction",
			parentId: originalLeafId,
		});
		expect(harness.session.execution.messages.map(getMessageText)).toContain("second assistant");
	});

	it("rejects a second navigation while the first is waiting", async () => {
		const navigationStarted = createDeferred();
		const navigationReleased = createDeferred();
		harness = await createHarness({});

		const secondTargetId = harness.sessionManager.appendMessage(userMsg("first user"));
		const firstTargetId = harness.sessionManager.appendMessage(assistantMsg("first assistant"));
		harness.sessionManager.appendMessage(userMsg("second user"));
		const originalLeafId = harness.sessionManager.appendMessage(assistantMsg("second assistant"));

		useSummaryResponses(harness, [
			async () => {
				navigationStarted.resolve();
				await navigationReleased.promise;
				return fauxAssistantMessage("branch summary");
			},
		]);
		const firstNavigation = harness.session.execution.navigateTree(firstTargetId, { summarize: true });
		await navigationStarted.promise;

		const secondNavigation = harness.session.execution.navigateTree(secondTargetId, { summarize: false });
		expect(harness.sessionManager.getLeafId()).toBe(originalLeafId);
		navigationReleased.resolve();

		await expect(secondNavigation).rejects.toThrow(
			"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
		);
		await firstNavigation;
		expect(harness.sessionManager.getLeafEntry()).toMatchObject({ type: "branch_summary", parentId: firstTargetId });
	});
});
