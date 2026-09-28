import { describe, expect, test } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { SessionPresentation } from "../src/modes/interactive/session-presentation.ts";

describe("session presentation state", () => {
	test("projects compaction summaries with their billing notices", () => {
		const usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		};
		const entry: SessionEntry = {
			type: "compaction",
			id: "compact-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			summary: "summary",
			firstKeptEntryId: "message-1",
			tokensBefore: 500,
			usage,
		};

		expect(new SessionPresentation().projectEntries([entry])).toEqual([
			{
				role: "compactionSummary",
				summary: "summary",
				tokensBefore: 500,
				timestamp: Date.parse(entry.timestamp),
			},
			{ type: "compaction_cost", kind: "compaction", usage },
		]);
	});

	test("consumes boundary compaction entries once", () => {
		const presentation = new SessionPresentation();
		presentation.markEntriesRenderedByBoundaryCompaction(["entry-1", "entry-2"]);

		expect(presentation.consumeBoundaryCompactionEntry("entry-1")).toBe(true);
		expect(presentation.consumeBoundaryCompactionEntry("entry-1")).toBe(false);
		expect(presentation.consumeBoundaryCompactionEntry("entry-2")).toBe(true);
	});
});
