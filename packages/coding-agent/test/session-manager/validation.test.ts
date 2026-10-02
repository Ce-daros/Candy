import { describe, expect, it } from "vitest";
import { type FileEntry, SessionHistory } from "../../src/core/session-history.ts";

describe("session validation", () => {
	it.each([undefined, 1, 2, 4])("rejects a session header with version %s", (version) => {
		const entries = [
			{ type: "session", version, id: "session", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" },
		] as unknown as FileEntry[];
		expect(() => SessionHistory.inMemory("/tmp", undefined, entries)).toThrow(
			version === undefined ? "valid session header" : `Unsupported session version ${version}; expected 3`,
		);
	});

	it.each([undefined, null])("rejects a stored user message with content %s", (content) => {
		const entries = [
			{ type: "session", version: 3, id: "session", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "message",
				parentId: null,
				timestamp: "2026-01-01T00:00:01Z",
				message: { role: "user", content, timestamp: 1 },
			},
		] as unknown as FileEntry[];
		expect(() => SessionHistory.inMemory("/tmp", undefined, entries)).toThrow(
			"Session message message (user) has no content",
		);
	});

	it("rejects stored assistant usage without totalTokens", () => {
		const entries = [
			{ type: "session", version: 3, id: "session", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "message",
				parentId: null,
				timestamp: "2026-01-01T00:00:01Z",
				message: {
					role: "assistant",
					content: [],
					api: "test",
					provider: "test",
					model: "test",
					timestamp: 1,
					stopReason: "stop",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			},
		] as unknown as FileEntry[];
		expect(() => SessionHistory.inMemory("/tmp", undefined, entries)).toThrow(
			"Session message message (assistant) has an invalid structure",
		);
	});

	it("rejects malformed current message roles and content blocks with entry location", () => {
		const entries = [
			{ type: "session", id: "sess-1", version: 3, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "badmsg01",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "alien", content: [{ type: "text", text: "invalid role" }], timestamp: 1 },
			},
		] as unknown as FileEntry[];

		expect(() => SessionHistory.inMemory("/tmp", undefined, entries)).toThrow(
			'Session message badmsg01 has unsupported message role "alien"',
		);
		entries[1] = {
			type: "message",
			id: "badmsg02",
			parentId: null,
			timestamp: "2025-01-01T00:00:01Z",
			message: { role: "user", content: [{ type: "unknown" }], timestamp: 1 },
		} as unknown as FileEntry;
		expect(() => SessionHistory.inMemory("/tmp", undefined, entries)).toThrow(
			"Session message badmsg02 (user) has an invalid unknown content block at index 0",
		);
	});

	it("rejects references that do not exist in loaded history", () => {
		const entries = [
			{ type: "session", id: "sess-1", version: 3, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "context_edit",
				id: "edit0001",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				targetId: "missing1",
				replacement: null,
			},
		] as unknown as FileEntry[];

		expect(() => SessionHistory.inMemory("/tmp", undefined, entries)).toThrow(
			"Context edit edit0001 refers to missing target missing1",
		);
	});

	it("rejects a loaded history with a missing parent", () => {
		const entries = [
			{ type: "session", id: "sess-1", version: 3, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "orphan01",
				parentId: "missing01",
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "hello", timestamp: 1 },
			},
		] as unknown as FileEntry[];

		expect(() => SessionHistory.inMemory("/tmp", undefined, entries)).toThrow(
			"Session entry orphan01 refers to missing parent missing01",
		);
	});
});
