import { uuidv7 } from "@candy/ai";
import { randomUUID } from "crypto";

import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type SessionEntry,
	type SessionMessageEntry,
} from "./session-records.ts";
export function createSessionId(): string {
	return uuidv7();
}

export function assertValidSessionId(id: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error(
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

/** Generate a unique short ID (8 hex chars, collision-checked) */
export function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	// Fallback to full UUID if somehow we have collisions
	return randomUUID();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateContentBlocks(content: unknown, entryId: string, role: string): void {
	if (!Array.isArray(content)) throw new Error(`Session message ${entryId} (${role}) has invalid content blocks`);
	for (const [index, block] of content.entries()) {
		if (!isRecord(block) || typeof block.type !== "string") {
			throw new Error(`Session message ${entryId} (${role}) has an invalid content block at index ${index}`);
		}
		const valid =
			(block.type === "text" && typeof block.text === "string") ||
			(block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") ||
			(role === "assistant" && block.type === "thinking" && typeof block.thinking === "string") ||
			(role === "assistant" &&
				block.type === "toolCall" &&
				typeof block.id === "string" &&
				typeof block.name === "string" &&
				isRecord(block.arguments));
		if (!valid)
			throw new Error(
				`Session message ${entryId} (${role}) has an invalid ${block.type} content block at index ${index}`,
			);
	}
}

function validateStoredMessage(entry: SessionMessageEntry): void {
	const message = entry.message as unknown;
	if (!isRecord(message) || typeof message.role !== "string") {
		throw new Error(`Session message ${entry.id} has no valid message object or role`);
	}
	const role = message.role;
	if (role === "bashExecution") {
		if (
			typeof message.command !== "string" ||
			typeof message.output !== "string" ||
			(message.exitCode !== undefined && typeof message.exitCode !== "number") ||
			typeof message.cancelled !== "boolean" ||
			typeof message.truncated !== "boolean" ||
			typeof message.timestamp !== "number"
		)
			throw new Error(`Session message ${entry.id} (bashExecution) has an invalid structure`);
		return;
	}
	if (role === "branchSummary") {
		if (
			typeof message.summary !== "string" ||
			(message.fromId !== null && typeof message.fromId !== "string") ||
			typeof message.timestamp !== "number"
		) {
			throw new Error(`Session message ${entry.id} (branchSummary) has an invalid structure`);
		}
		return;
	}
	if (role === "compactionSummary") {
		if (
			typeof message.summary !== "string" ||
			typeof message.tokensBefore !== "number" ||
			typeof message.timestamp !== "number"
		) {
			throw new Error(`Session message ${entry.id} (compactionSummary) has an invalid structure`);
		}
		return;
	}
	if (!["system", "user", "assistant", "toolResult", "custom"].includes(role)) {
		throw new Error(`Session message ${entry.id} has unsupported message role "${role}"`);
	}
	if (message.content === null || message.content === undefined) {
		throw new Error(`Session message ${entry.id} (${role}) has no content`);
	}
	if (typeof message.content === "string" && !["system", "user", "custom"].includes(role)) {
		throw new Error(`Session message ${entry.id} (${role}) requires content blocks`);
	}
	if (typeof message.content !== "string") {
		validateContentBlocks(message.content, entry.id, role);
		if (
			role === "system" &&
			(message.content as unknown[]).some((block) => !isRecord(block) || block.type !== "text")
		) {
			throw new Error(`Session message ${entry.id} (system) accepts text blocks only`);
		}
	}
	if (role === "system" && typeof message.timestamp !== "number") {
		throw new Error(`Session message ${entry.id} (system) has no valid timestamp`);
	}
	if (role === "assistant") {
		if (
			typeof message.api !== "string" ||
			typeof message.provider !== "string" ||
			typeof message.model !== "string" ||
			!isRecord(message.usage) ||
			!isUsage(message.usage) ||
			!(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"] as const).includes(
				message.stopReason as "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred",
			)
		)
			throw new Error(`Session message ${entry.id} (assistant) has an invalid structure`);
	}
	if (
		role === "toolResult" &&
		(typeof message.toolCallId !== "string" ||
			typeof message.toolName !== "string" ||
			typeof message.isError !== "boolean")
	)
		throw new Error(`Session message ${entry.id} (toolResult) has an invalid structure`);
	if (role === "custom" && (typeof message.customType !== "string" || typeof message.display !== "boolean")) {
		throw new Error(`Session message ${entry.id} (custom) has an invalid structure`);
	}
	if (role !== "system" && typeof message.timestamp !== "number") {
		throw new Error(`Session message ${entry.id} (${role}) has no valid timestamp`);
	}
}

function isUsage(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const cost = value.cost;
	if (!isRecord(cost)) return false;
	const numbers = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
	const costs = ["input", "output", "cacheRead", "cacheWrite", "total"];
	return (
		numbers.every((key) => typeof value[key] === "number" && Number.isFinite(value[key])) &&
		costs.every((key) => typeof cost[key] === "number" && Number.isFinite(cost[key])) &&
		(value.cacheWrite1h === undefined ||
			(typeof value.cacheWrite1h === "number" && Number.isFinite(value.cacheWrite1h))) &&
		(value.reasoning === undefined || (typeof value.reasoning === "number" && Number.isFinite(value.reasoning)))
	);
}

const SESSION_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function validateEntryStructure(entry: SessionEntry): void {
	const entryType = entry.type;
	const entryId = entry.id;
	if (typeof entry.id !== "string" || entry.id.length === 0) throw new Error("Session entry has no id");
	if (typeof entry.timestamp !== "string" || entry.timestamp.length === 0) {
		throw new Error(`Session entry ${entry.id} has no valid timestamp`);
	}
	if (entry.parentId !== null && typeof entry.parentId !== "string") {
		throw new Error(`Session entry ${entry.id} has invalid parentId ${String(entry.parentId)}`);
	}
	switch (entry.type) {
		case "message":
			validateStoredMessage(entry);
			break;
		case "thinking_level_change":
			if (!SESSION_THINKING_LEVELS.has(entry.thinkingLevel)) {
				throw new Error(`Thinking level change ${entry.id} has invalid level ${entry.thinkingLevel}`);
			}
			break;
		case "model_change":
			if (
				typeof entry.provider !== "string" ||
				entry.provider.length === 0 ||
				typeof entry.modelId !== "string" ||
				entry.modelId.length === 0
			)
				throw new Error(`Model change ${entry.id} has no valid provider or model id`);
			break;
		case "usage":
			if (
				typeof entry.kind !== "string" ||
				entry.kind.length === 0 ||
				typeof entry.provider !== "string" ||
				entry.provider.length === 0 ||
				typeof entry.model !== "string" ||
				entry.model.length === 0 ||
				!isUsage(entry.usage) ||
				(entry.note !== undefined && typeof entry.note !== "string")
			) {
				throw new Error(`Usage entry ${entry.id} has an invalid structure`);
			}
			break;
		case "compaction":
			if (
				typeof entry.summary !== "string" ||
				!Number.isFinite(entry.tokensBefore) ||
				typeof entry.firstKeptEntryId !== "string" ||
				entry.firstKeptEntryId.length === 0 ||
				(entry.usage !== undefined && !isUsage(entry.usage))
			)
				throw new Error(`Compaction ${entry.id} has an invalid structure`);
			if (entry.systemMessage !== undefined) {
				if (
					entry.systemMessage.role !== "system" ||
					typeof entry.systemMessage.timestamp !== "number" ||
					(typeof entry.systemMessage.content !== "string" && !Array.isArray(entry.systemMessage.content))
				)
					throw new Error(`Compaction ${entry.id} has an invalid system message`);
				if (typeof entry.systemMessage.content !== "string")
					validateContentBlocks(entry.systemMessage.content, entry.id, "system");
			}
			break;
		case "branch_summary":
			if (
				typeof entry.fromId !== "string" ||
				typeof entry.summary !== "string" ||
				(entry.usage !== undefined && !isUsage(entry.usage))
			)
				throw new Error(`Branch summary ${entry.id} has an invalid structure`);
			break;
		case "custom":
			if (typeof entry.customType !== "string" || entry.customType.length === 0)
				throw new Error(`Custom entry ${entry.id} has no valid custom type`);
			break;
		case "custom_message":
			if (
				typeof entry.customType !== "string" ||
				entry.customType.length === 0 ||
				typeof entry.display !== "boolean" ||
				entry.content === null ||
				entry.content === undefined
			) {
				throw new Error(`Custom message entry ${entry.id} has an invalid structure`);
			}
			if (typeof entry.content !== "string") validateContentBlocks(entry.content, entry.id, "custom_message");
			break;
		case "context_edit":
			if (entry.replacement !== null) {
				if (!isRecord(entry.replacement) || !("content" in entry.replacement)) {
					throw new Error(`Context edit ${entry.id} has an invalid replacement`);
				}
				if (typeof entry.replacement.content !== "string" && !Array.isArray(entry.replacement.content)) {
					throw new Error(`Context edit ${entry.id} has invalid content`);
				}
			}
			break;
		case "label":
			if (entry.label !== undefined && typeof entry.label !== "string")
				throw new Error(`Label ${entry.id} has an invalid value`);
			break;
		case "session_info":
			if (entry.name !== undefined && typeof entry.name !== "string")
				throw new Error(`Session info ${entry.id} has an invalid name`);
			break;
		default:
			throw new Error(`Session entry ${entryId} has unsupported entry type "${entryType}"`);
	}
}

function validateEntryReferences(
	entry: SessionEntry,
	has: (id: string) => boolean,
	get: (id: string) => SessionEntry | undefined,
): void {
	if (entry.parentId !== null && !has(entry.parentId)) {
		throw new Error(`Session entry ${entry.id} refers to missing parent ${entry.parentId}`);
	}
	if (entry.type === "compaction") {
		let ancestorId = entry.parentId;
		let found = entry.firstKeptEntryId === entry.id;
		while (!found && ancestorId !== null) {
			if (ancestorId === entry.firstKeptEntryId) found = true;
			ancestorId = get(ancestorId)?.parentId ?? null;
		}
		if (!found)
			throw new Error(
				`Compaction ${entry.id} refers to first kept entry ${entry.firstKeptEntryId} outside its parent chain`,
			);
	}
	if (entry.type === "context_edit") {
		const target = get(entry.targetId);
		if (!target) throw new Error(`Context edit ${entry.id} refers to missing target ${entry.targetId}`);
		if (
			!(
				target.type === "custom_message" ||
				(target.type === "message" && ["user", "assistant", "toolResult"].includes(target.message.role))
			)
		) {
			throw new Error(`Context edit ${entry.id} refers to non-editable target ${entry.targetId}`);
		}
		if (entry.replacement !== null && typeof entry.replacement.content !== "string") {
			validateContentBlocks(
				entry.replacement.content,
				entry.id,
				target.type === "message" ? target.message.role : "custom",
			);
		}
		let ancestorId = entry.parentId;
		let onParentChain = false;
		while (ancestorId !== null) {
			if (ancestorId === entry.targetId) onParentChain = true;
			ancestorId = get(ancestorId)?.parentId ?? null;
		}
		if (!onParentChain)
			throw new Error(`Context edit ${entry.id} refers to target ${entry.targetId} outside its parent chain`);
	}
	if (entry.type === "label" && !has(entry.targetId))
		throw new Error(`Label ${entry.id} refers to missing target ${entry.targetId}`);
	if (entry.type === "branch_summary" && !has(entry.fromId))
		throw new Error(`Branch summary ${entry.id} refers to missing source ${entry.fromId}`);
}

export function validateNewEntries(entries: readonly SessionEntry[], existing: Map<string, SessionEntry>): void {
	const pending = new Map<string, SessionEntry>();
	const has = (id: string) => pending.has(id) || existing.has(id);
	const get = (id: string) => pending.get(id) ?? existing.get(id);
	for (const entry of entries) {
		validateEntryStructure(entry);
		if (has(entry.id)) throw new Error(`Session entry ${entry.id} is duplicated`);
		validateEntryReferences(entry, has, get);
		pending.set(entry.id, entry);
	}
}

export function validateSessionEntries(entries: FileEntry[]): void {
	const header = entries[0];
	if (
		!header ||
		header.type !== "session" ||
		typeof header.id !== "string" ||
		header.id.length === 0 ||
		typeof header.cwd !== "string" ||
		typeof header.timestamp !== "string" ||
		typeof header.version !== "number"
	)
		throw new Error("Session history must begin with a valid session header");
	if (header.version !== CURRENT_SESSION_VERSION) {
		throw new Error(`Unsupported session version ${header.version}; expected ${CURRENT_SESSION_VERSION}`);
	}
	const byId = new Map<string, SessionEntry>();
	for (const [index, entry] of entries.entries()) {
		if (index === 0) continue;
		if (entry.type === "session") throw new Error(`Unexpected session header at line ${index + 1}`);
		validateEntryStructure(entry);
		if (byId.has(entry.id)) throw new Error(`Session entry ${entry.id} is duplicated at line ${index + 1}`);
		if (entry.parentId !== null && !byId.has(entry.parentId)) {
			throw new Error(`Session entry ${entry.id} refers to missing parent ${entry.parentId}`);
		}
		byId.set(entry.id, entry);
	}
	const has = (id: string) => byId.has(id);
	const get = (id: string) => byId.get(id);
	for (const entry of byId.values()) validateEntryReferences(entry, has, get);
}
