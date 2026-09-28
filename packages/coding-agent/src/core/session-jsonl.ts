import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { normalizePath } from "../utils/paths.ts";
import type { FileEntry, SessionHeader } from "./session-manager.ts";

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
const SESSION_HEADER_READ_BUFFER_SIZE = 4096;
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;

export class SessionHeaderScanLimitError extends Error {
	constructor(filePath: string) {
		super(`Session header exceeds ${MAX_SESSION_HEADER_SCAN_BYTES}-byte scan limit: ${filePath}`);
		this.name = "SessionHeaderScanLimitError";
	}
}

export function parseSessionEntryLine(line: string, filePath: string, lineNumber: number): FileEntry | null {
	if (!line.trim()) return null;
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch (error) {
		throw new Error(`Invalid session JSON at ${filePath}:${lineNumber}`, { cause: error });
	}
	if (typeof entry !== "object" || entry === null || !("type" in entry) || typeof entry.type !== "string") {
		throw new Error(`Invalid session entry at ${filePath}:${lineNumber}`);
	}
	return entry as FileEntry;
}

export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const entries: FileEntry[] = [];
	let pending = "";
	let lineNumber = 1;
	const fd = openSync(resolvedFilePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				const entry = parseSessionEntryLine(pending.slice(lineStart, newlineIndex), resolvedFilePath, lineNumber++);
				if (entry) entries.push(entry);
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}
		pending += decoder.end();
		const finalEntry = parseSessionEntryLine(pending, resolvedFilePath, lineNumber);
		if (finalEntry) entries.push(finalEntry);
	} finally {
		closeSync(fd);
	}
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		throw new Error(`Session file has no valid header: ${resolvedFilePath}`);
	}
	return entries;
}

function parseSessionHeaderCandidate(
	line: string,
	filePath: string,
	lineNumber: number,
): SessionHeader | null | undefined {
	if (!line.trim()) return undefined;
	const entry = parseSessionEntryLine(line, filePath, lineNumber);
	if (!entry) return undefined;
	if (entry.type !== "session" || typeof (entry as { id?: unknown }).id !== "string") return null;
	return entry;
}

export function readSessionHeader(filePath: string): SessionHeader | null {
	const fd = openSync(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_SIZE);
		const lineChunks: string[] = [];
		let scannedBytes = 0;
		let lineNumber = 1;
		while (scannedBytes < MAX_SESSION_HEADER_SCAN_BYTES) {
			const readLength = Math.min(buffer.length, MAX_SESSION_HEADER_SCAN_BYTES - scannedBytes);
			const bytesRead = readSync(fd, buffer, 0, readLength, null);
			if (bytesRead === 0) {
				lineChunks.push(decoder.end());
				return parseSessionHeaderCandidate(lineChunks.join(""), filePath, lineNumber) ?? null;
			}
			scannedBytes += bytesRead;
			const chunk = decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = chunk.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				lineChunks.push(chunk.slice(lineStart, newlineIndex));
				const header = parseSessionHeaderCandidate(lineChunks.join(""), filePath, lineNumber++);
				if (header !== undefined) return header;
				lineChunks.length = 0;
				lineStart = newlineIndex + 1;
				newlineIndex = chunk.indexOf("\n", lineStart);
			}
			lineChunks.push(chunk.slice(lineStart));
		}
		const probe = Buffer.allocUnsafe(1);
		if (readSync(fd, probe, 0, probe.length, null) === 0) {
			lineChunks.push(decoder.end());
			return parseSessionHeaderCandidate(lineChunks.join(""), filePath, lineNumber) ?? null;
		}
		throw new SessionHeaderScanLimitError(filePath);
	} finally {
		closeSync(fd);
	}
}

export function readSessionHeaderForDiscovery(filePath: string): SessionHeader | null {
	try {
		return readSessionHeader(filePath);
	} catch {
		return null;
	}
}
