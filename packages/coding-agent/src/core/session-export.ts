import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import { serializeSessionEntry, writeSessionFile } from "./session-jsonl.ts";
import {
	CURRENT_SESSION_VERSION,
	type ReadonlySessionHistory,
	type SessionEntry,
	type SessionHeader,
} from "./session-records.ts";

/** Preserve the original branches referenced by summaries, including their own references. */
export function getBranchSourceEntries(
	sessionManager: ReadonlySessionHistory,
	branch: readonly SessionEntry[],
): SessionEntry[] {
	const sources = new Set<string>();
	const pending = [...branch];
	for (let index = 0; index < pending.length; index++) {
		const entry = pending[index]!;
		const sourceId =
			entry.type === "branch_summary" ? entry.fromId : entry.type === "label" ? entry.targetId : undefined;
		if (sourceId === undefined || sources.has(sourceId)) continue;
		for (const source of sessionManager.getBranch(sourceId)) {
			if (sources.has(source.id)) continue;
			sources.add(source.id);
			pending.push(source);
		}
	}
	return sessionManager.getEntries().filter((entry) => sources.has(entry.id));
}

/** The current session branch as serializable entries, including its header. */
export function sessionBranchEntries(sessionManager: ReadonlySessionHistory): object[] {
	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionManager.getSessionId(),
		timestamp,
		cwd: sessionManager.getCwd(),
	};
	const branch = sessionManager.getBranch();
	const ids = new Set([...branch, ...getBranchSourceEntries(sessionManager, branch)].map((entry) => entry.id));
	return [header, ...sessionManager.getEntries().filter((entry) => ids.has(entry.id))];
}

/** Serialize the current session branch as JSONL. */
export function serializeSessionBranch(sessionManager: ReadonlySessionHistory): string {
	return sessionBranchEntries(sessionManager)
		.map((entry) => serializeSessionEntry(entry))
		.join("");
}

/** Write the current session branch as JSONL. */
export function exportSessionToJsonl(sessionManager: ReadonlySessionHistory, outputPath?: string): string {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeSessionFile(filePath, sessionBranchEntries(sessionManager), { flag: "w" });
	return filePath;
}
