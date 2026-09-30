import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import { serializeSessionEntry, writeSessionFile } from "./session-jsonl.ts";
import { CURRENT_SESSION_VERSION, type ReadonlySessionHistory, type SessionHeader } from "./session-records.ts";

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
	const entries: object[] = [header];
	let parentId: string | null = null;
	for (const entry of sessionManager.getBranch()) {
		entries.push({ ...entry, parentId });
		parentId = entry.id;
	}
	return entries;
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
