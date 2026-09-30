import { describe, expect, it } from "vitest";
import { type FileEntry, migrateSessionEntries, SessionHistory } from "../../src/core/session-history.ts";

describe("migrateSessionEntries", () => {
	it("should add id/parentId to v1 entries", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{ type: "message", timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "hi", timestamp: 1 } },
			{
				type: "message",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// Header should have version set (v3 is current after hookMessage->custom migration)
		expect((entries[0] as any).version).toBe(3);

		// Entries should have id/parentId
		const msg1 = entries[1] as any;
		const msg2 = entries[2] as any;

		expect(msg1.id).toBeDefined();
		expect(msg1.id.length).toBe(8);
		expect(msg1.parentId).toBeNull();

		expect(msg2.id).toBeDefined();
		expect(msg2.id.length).toBe(8);
		expect(msg2.parentId).toBe(msg1.id);
	});

	it("should be idempotent (skip already migrated)", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", version: 2, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "abc12345",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "message",
				id: "def67890",
				parentId: "abc12345",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// IDs should be unchanged
		expect((entries[1] as any).id).toBe("abc12345");
		expect((entries[2] as any).id).toBe("def67890");
		expect((entries[2] as any).parentId).toBe("abc12345");
	});

	it("migrates missing and null historical message content during load", () => {
		const entries = [
			{ type: "session", id: "sess-1", version: 3, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "legacy01",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: null, timestamp: 1 },
			},
			{
				type: "message",
				id: "legacy02",
				parentId: "legacy01",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					api: "test",
					provider: "test",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "legacy03",
				parentId: "legacy02",
				timestamp: "2025-01-01T00:00:03Z",
				message: {
					role: "bashExecution",
					command: "echo ok",
					output: "ok",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 3,
				},
			},
		] as unknown as FileEntry[];

		const session = SessionHistory.inMemory("/tmp", undefined, entries);

		expect((session.getEntry("legacy01") as any).message.content).toEqual([]);
		expect((session.getEntry("legacy02") as any).message.content).toEqual([]);
		expect((session.getEntry("legacy03") as any).message.role).toBe("bashExecution");
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
