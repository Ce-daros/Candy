import { fauxAssistantMessage } from "@candy/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { useSummaryResponses } from "../summarization.ts";

describe("compaction reason", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const h of harnesses.splice(0)) await h.cleanup();
	});
	it.each(["manual", "threshold", "overflow"] as const)("reports %s and its retry decision", async (reason) => {
		const h = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await h.session.execution.prompt("first");
		await h.session.execution.prompt("second");
		useSummaryResponses(h, [fauxAssistantMessage("summary"), fauxAssistantMessage("summary")]);
		if (reason === "manual") await h.session.execution.compact();
		else
			await (
				h.session.execution as unknown as { _runAutoCompaction(reason: string, retry: boolean): Promise<boolean> }
			)._runAutoCompaction(reason, reason === "overflow");
		expect(h.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason }]);
		expect(h.eventsOfType("compaction_end")).toHaveLength(1);
		expect(h.eventsOfType("compaction_end")[0]).toMatchObject({
			reason,
			willRetry: reason === "overflow",
			aborted: false,
			result: { summary: expect.stringContaining("summary") },
		});
	});
});
