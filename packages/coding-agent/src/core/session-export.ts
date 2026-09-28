import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader, type SessionManager } from "./session-manager.ts";

/** Serialize the current session branch as JSONL. */
export function serializeSessionBranch(sessionManager: SessionManager): string {
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
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** Write the current session branch as JSONL. */
export function exportSessionToJsonl(sessionManager: SessionManager, outputPath?: string): string {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(filePath, serializeSessionBranch(sessionManager));
	return filePath;
}
