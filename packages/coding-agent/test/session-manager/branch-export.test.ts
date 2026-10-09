import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionHistory } from "../../src/core/session-history.ts";
import { userMsg } from "../utilities.ts";

describe.each(["export", "fork", "in-memory fork"] as const)("%s with branch summaries", (operation) => {
	let directory: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "candy-branch-export-"));
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("preserves nested source branches and their references without changing active context", () => {
		const session =
			operation === "in-memory fork"
				? SessionHistory.inMemory(directory)
				: SessionHistory.create(directory, directory);
		const root = session.appendMessage(userMsg("root"));
		const source = session.appendMessage(userMsg("first abandoned branch"));
		const sourceLabel = session.appendLabelChange(source, "source checkpoint");
		session.appendCompaction("source compaction", sourceLabel, 100);
		const compactedSource = session.appendMessage(userMsg("after source compaction"));
		const firstSummary = session.branchWithSummary(root, "first summary");
		const secondSource = session.appendMessage(userMsg("second abandoned branch"));
		const secondSummary = session.branchWithSummary(root, "second summary");
		const leaf = session.appendMessage(userMsg("active branch"));
		const context = session.buildSessionContext();

		// This unrelated branch must still be excluded from the saved branch.
		session.branch(root);
		const unrelated = session.appendMessage(userMsg("unrelated branch"));
		session.branch(leaf);

		const path =
			operation === "export"
				? session.exportToJsonl(join(directory, "export.jsonl"))
				: session.createBranchedSession(leaf);
		const restored = path ? SessionHistory.open(path) : session;
		expect(restored.buildSessionContext()).toEqual(context);
		expect(restored.getLeafId()).toBe(leaf);
		expect(restored.getEntry(unrelated)).toBeUndefined();
		expect(restored.getEntry(firstSummary)).toMatchObject({ type: "branch_summary", fromId: compactedSource });
		expect(restored.getEntry(secondSummary)).toMatchObject({ type: "branch_summary", fromId: secondSource });
		expect(restored.getEntry(sourceLabel)).toMatchObject({ type: "label", targetId: source });
		expect(restored.getBranch().map((entry) => entry.id)).toEqual([root, secondSummary, leaf]);
	});

	it("preserves a source label that refers to another branch", () => {
		const session =
			operation === "in-memory fork"
				? SessionHistory.inMemory(directory)
				: SessionHistory.create(directory, directory);
		const root = session.appendMessage(userMsg("root"));
		const other = session.appendMessage(userMsg("other branch"));
		session.branch(root);
		const sourceLabel = session.appendLabelChange(other, "other checkpoint");
		session.branchWithSummary(root, "summary of source label");
		const leaf = session.appendMessage(userMsg("active"));
		const context = session.buildSessionContext();
		const path =
			operation === "export"
				? session.exportToJsonl(join(directory, "export.jsonl"))
				: session.createBranchedSession(leaf);
		const restored = path ? SessionHistory.open(path) : session;
		expect(restored.getEntry(sourceLabel)).toMatchObject({ type: "label", targetId: other });
		expect(restored.getEntry(other)).toBeDefined();
		expect(restored.buildSessionContext()).toEqual(context);
	});
});
