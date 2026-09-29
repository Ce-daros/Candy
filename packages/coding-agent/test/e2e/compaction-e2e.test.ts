import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getBuiltinModel as getModel } from "@candy/ai/providers/all";
import { describe, expect, it } from "vitest";
import { compact, DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../../src/core/compaction/index.ts";
import type { CompactionEntry, SessionEntry } from "../../src/core/session-manager.ts";
import { buildSessionContext, migrateSessionEntries, parseSessionEntries } from "../../src/core/session-manager.ts";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;

function loadLargeSessionEntries(): SessionEntry[] {
	const sessionPath = join(__dirname, "../fixtures/large-session.jsonl");
	const entries = parseSessionEntries(readFileSync(sessionPath, "utf-8"));
	migrateSessionEntries(entries);
	return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
}

describe.skipIf(!ANTHROPIC_API_KEY)("LLM summarization", () => {
	it("should generate a compaction result for the large session", async () => {
		const entries = loadLargeSessionEntries();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();

		const compactionResult = await compact(preparation!, model, ANTHROPIC_API_KEY!);

		expect(compactionResult.summary.length).toBeGreaterThan(100);
		expect(compactionResult.firstKeptEntryId).toBeTruthy();
		expect(compactionResult.tokensBefore).toBeGreaterThan(0);

		console.log("Summary length:", compactionResult.summary.length);
		console.log("First kept entry ID:", compactionResult.firstKeptEntryId);
		console.log("Tokens before:", compactionResult.tokensBefore);
		console.log("\n--- SUMMARY ---\n");
		console.log(compactionResult.summary);
	}, 60000);

	it("should produce valid session after compaction", async () => {
		const entries = loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();

		const compactionResult = await compact(preparation!, model, ANTHROPIC_API_KEY!);
		const lastEntry = entries[entries.length - 1];
		const compactionEntry: CompactionEntry = {
			type: "compaction",
			id: "compaction-test-id",
			parentId: lastEntry.id,
			timestamp: new Date().toISOString(),
			...compactionResult,
		};
		const reloaded = buildSessionContext([...entries, compactionEntry]);

		expect(reloaded.messages.length).toBeLessThan(loaded.messages.length);
		expect(reloaded.messages[0].role).toBe("compactionSummary");
		expect((reloaded.messages[0] as { summary: string }).summary).toContain(compactionResult.summary);
	}, 60000);
});
