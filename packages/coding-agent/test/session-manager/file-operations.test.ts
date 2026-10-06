import { constants as bufferConstants } from "buffer";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findMostRecentSession,
	loadEntriesFromFile,
	SessionDiscovery,
	type SessionDiscoveryError,
	SessionHistory,
} from "../../src/core/session-history.ts";
import { assistantMsg, readSessionFileRoles, userMsg } from "../utilities.ts";

const HEADER_SCAN_LIMIT_BYTES = 1024 * 1024;

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSessionHeader(file: string, cwd: string, id: string, prefix = ""): void {
		writeFileSync(
			file,
			`${prefix}${JSON.stringify({
				type: "session",
				version: 3,
				id,
				timestamp: "2025-01-01T00:00:00Z",
				cwd,
			})}\n`,
		);
	}

	it("returns empty array for non-existent file", () => {
		const entries = loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("returns empty array for empty file", () => {
		const file = join(tempDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("rejects a file without a session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(() => loadEntriesFromFile(file)).toThrow("no valid header");
	});

	it("reports malformed JSON with its line", () => {
		const file = join(tempDir, "malformed.jsonl");
		writeFileSync(file, "not json\n");
		expect(() => loadEntriesFromFile(file)).toThrow(`${file}:1`);
	});

	it("rejects unknown entry types with their line", () => {
		const file = join(tempDir, "unknown-entry.jsonl");
		writeSessionHeader(file, tempDir, "unknown-entry");
		appendFileSync(file, '{"type":"future_entry","id":"1","parentId":null}\n');
		expect(() => loadEntriesFromFile(file)).toThrow(`Unknown session entry type "future_entry" at ${file}:2`);
	});

	it("loads valid session file", () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("rejects malformed middle lines", () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		expect(() => loadEntriesFromFile(file)).toThrow(`${file}:2`);
	});

	it("reads an unterminated valid record without modifying the file", () => {
		const file = join(tempDir, "unterminated.jsonl");
		const content =
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}';
		writeFileSync(file, content);

		expect(loadEntriesFromFile(file)).toHaveLength(2);
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	it("rewrites an unterminated valid record on the next save", () => {
		const file = join(tempDir, "unterminated-save.jsonl");
		const content = '{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}';
		writeFileSync(file, content);
		const session = SessionHistory.open(file, tempDir);
		expect(readFileSync(file, "utf8")).toBe(content);

		session.appendMessage(userMsg("hello"));
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1]).type).toBe("message");
	});

	it("rejects an unsupported session version without modifying the file", () => {
		const file = join(tempDir, "v2.jsonl");
		const content = '{"type":"session","version":2,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n';
		writeFileSync(file, content);
		expect(() => SessionHistory.open(file, tempDir)).toThrow("Unsupported session version 2; expected 3");
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	it("rejects an unterminated malformed final fragment without modifying the file", () => {
		const file = join(tempDir, "malformed-tail.jsonl");
		const content =
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
			'{"type":"message"';
		writeFileSync(file, content);

		expect(() => loadEntriesFromFile(file)).toThrow(`${file}:2`);
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	it("does not modify an unterminated non-session file", () => {
		const file = join(tempDir, "invalid.jsonl");
		const content = '{"type":"message","id":"1"}';
		writeFileSync(file, content);

		expect(() => loadEntriesFromFile(file)).toThrow("no valid header");
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	it.each([
		["leading blank lines", "\n  \n", "leading-blank"],
		["a multi-buffer header", "", "a".repeat(8192)],
	])("reads cwd from a session with %s", (_description, prefix, sessionId) => {
		const file = join(tempDir, "header.jsonl");
		const storedCwd = join(tempDir, "stored-project");
		writeSessionHeader(file, storedCwd, sessionId, prefix);

		const sessionManager = SessionHistory.open(file, tempDir);
		expect(sessionManager.getSessionId()).toBe(sessionId);
		expect(sessionManager.getCwd()).toBe(storedCwd);
	});

	it("opens compatible sessions beyond the discovery scan limit", () => {
		const storedCwd = join(tempDir, "stored-project");
		const overrideCwd = join(tempDir, "override-project");
		const cases = [{ name: "large-header", id: "a".repeat(HEADER_SCAN_LIMIT_BYTES + 1), prefix: "" }];

		for (const { name, id, prefix } of cases) {
			const file = join(tempDir, `${name}.jsonl`);
			writeSessionHeader(file, storedCwd, id, prefix);
			for (const cwdOverride of [undefined, overrideCwd]) {
				const sessionManager = SessionHistory.open(file, tempDir, cwdOverride);
				expect(sessionManager.getSessionId()).toBe(id);
				expect(sessionManager.getCwd()).toBe(cwdOverride ?? storedCwd);
			}
		}
	});

	it("rejects corrupt sparse session files larger than Node's max string length", () => {
		const file = join(tempDir, "large.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);

		const fd = openSync(file, "r+");
		try {
			const newline = Buffer.from("\n");
			const stride = 16 * 1024 * 1024;
			for (let offset = stride; offset <= bufferConstants.MAX_STRING_LENGTH + stride; offset += stride) {
				writeSync(fd, newline, 0, newline.length, offset);
			}
		} finally {
			closeSync(fd);
		}

		appendFileSync(
			file,
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);

		expect(() => SessionHistory.open(file, tempDir)).toThrow(`${file}:2`);
	});
});

describe("session append commits", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-append-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not publish an entry when the first history write fails", () => {
		const session = SessionHistory.create(tempDir, tempDir);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Persistent session should have a file path");
		mkdirSync(sessionFile);

		expect(() => session.appendMessage(userMsg("hello"))).toThrow();
		expect(session.getEntries()).toEqual([]);
		expect(session.getLeafId()).toBeNull();
	});

	it("keeps entries and the leaf unchanged when an append to a saved session fails", () => {
		const session = SessionHistory.create(tempDir, tempDir);
		const leaf = session.appendMessage(userMsg("saved"));
		const entries = session.getEntries();
		const sessionFile = session.getSessionFile()!;
		rmSync(sessionFile);
		mkdirSync(sessionFile);
		expect(() => session.appendMessage(userMsg("unsaved"))).toThrow();
		expect(() => session.appendModelSelection("test", "model", "high")).toThrow();
		expect(session.getEntries()).toEqual(entries);
		expect(session.getLeafId()).toBe(leaf);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for empty directory", () => {
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", () => {
		expect(findMostRecentSession(join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		writeFileSync(join(tempDir, "file.json"), "{}");
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", () => {
		writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = join(tempDir, "older.jsonl");
		const file2 = join(tempDir, "newer.jsonl");

		writeFileSync(
			file1,
			'{"type":"session","version":3,"id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);
		// Small delay to ensure different mtime
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(
			file2,
			'{"type":"session","version":3,"id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);

		expect(findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = join(tempDir, "invalid.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(
			valid,
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});

	it("skips oversized corrupt files and returns a valid session", () => {
		const invalid = join(tempDir, "oversized.jsonl");
		const valid = join(tempDir, "valid.jsonl");
		writeFileSync(invalid, "x".repeat(HEADER_SCAN_LIMIT_BYTES + 1));
		writeFileSync(
			valid,
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});

	it("filters most recent session by cwd", async () => {
		const projectA = join(tempDir, "project-a");
		const projectB = join(tempDir, "project-b");
		const fileA = join(tempDir, "a.jsonl");
		const fileB = join(tempDir, "b.jsonl");

		writeFileSync(
			fileA,
			`${JSON.stringify({ type: "session", version: 3, id: "a", timestamp: "2025-01-01T00:00:00Z", cwd: projectA })}\n`,
		);
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(
			fileB,
			`${JSON.stringify({ type: "session", version: 3, id: "b", timestamp: "2025-01-01T00:00:00Z", cwd: projectB })}\n`,
		);

		expect(findMostRecentSession(tempDir, projectA)).toBe(fileA);
		expect(findMostRecentSession(tempDir, projectB)).toBe(fileB);
	});
});

describe("SessionHistory custom flat session directory", () => {
	let tempDir: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		projectA = join(tempDir, "project-a");
		projectB = join(tempDir, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createPersistedSession(cwd: string, label: string): string {
		const session = SessionHistory.create(cwd, tempDir);
		session.appendMessage({ role: "user", content: label, timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `reply to ${label}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected persisted session file");
		}
		return sessionFile;
	}

	it("scopes current-folder APIs by cwd while listing all flat sessions", async () => {
		const sessionA = createPersistedSession(projectA, "from A");
		await new Promise((r) => setTimeout(r, 10));
		const sessionB = createPersistedSession(projectB, "from B");

		const currentA = await SessionDiscovery.list(projectA, tempDir);
		expect(currentA.map((session) => session.path)).toEqual([sessionA]);

		const all = await SessionDiscovery.listAll(tempDir);
		expect(new Set(all.map((session) => session.path))).toEqual(new Set([sessionA, sessionB]));

		const continuedA = SessionHistory.continueRecent(projectA, tempDir);
		expect(continuedA.getSessionFile()).toBe(sessionA);
	});

	it("lists valid sessions and reports corrupt files without modifying them", async () => {
		const valid = createPersistedSession(projectA, "valid");
		const broken = join(tempDir, "broken.jsonl");
		const contents = `${readFileSync(valid, "utf8")}{broken\n`;
		writeFileSync(broken, contents);
		let errors: readonly SessionDiscoveryError[] = [];
		const progress = (
			_loaded: number,
			_total: number,
			_sessions?: readonly unknown[],
			failures?: readonly SessionDiscoveryError[],
		) => {
			if (failures) errors = failures;
		};
		for (const list of [
			() => SessionDiscovery.list(projectA, tempDir, progress),
			() => SessionDiscovery.listAll(tempDir, progress),
		]) {
			expect((await list()).map((session) => session.path)).toEqual([valid]);
			expect(errors).toEqual([{ path: broken, message: `Invalid session JSON at ${broken}:4` }]);
		}
		expect(readFileSync(broken, "utf8")).toBe(contents);
	});

	it("reports a session directory that cannot be listed instead of returning an empty list", async () => {
		const file = join(tempDir, "not-a-directory");
		writeFileSync(file, "file");
		await expect(SessionDiscovery.listAll(file)).rejects.toMatchObject({ code: "ENOTDIR" });
	});

	it("rejects a cancelled session listing", async () => {
		createPersistedSession(projectA, "from A");
		createPersistedSession(projectB, "from B");
		const controller = new AbortController();
		const listing = SessionDiscovery.listAll(
			tempDir,
			(_loaded, _total, partialSessions) => {
				if (partialSessions) controller.abort();
			},
			controller.signal,
		);

		await expect(listing).rejects.toMatchObject({ name: "AbortError" });
		await expect(SessionDiscovery.listAll(undefined, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
	});
});

describe("SessionHistory.setSessionFile with corrupted files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps an empty file unchanged until a message is saved", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm = SessionHistory.open(emptyFile, tempDir);

		// Should have created a new session with valid header
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		expect(readFileSync(emptyFile, "utf-8")).toBe("");
		sm.appendMessage(userMsg("hello"));
		const lines = readFileSync(emptyFile, "utf-8").trim().split("\n");
		expect(JSON.parse(lines[0]).id).toBe(sm.getSessionId());
		expect(lines).toHaveLength(2);
	});

	it("throws and preserves non-empty file without valid header", () => {
		const noHeaderFile = join(tempDir, "no-header.jsonl");
		const originalContent =
			'{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n';
		writeFileSync(noHeaderFile, originalContent);

		expect(() => SessionHistory.open(noHeaderFile, tempDir)).toThrow(
			`Session file has no valid header: ${noHeaderFile}`,
		);
		expect(readFileSync(noHeaderFile, "utf-8")).toBe(originalContent);
	});

	it("throws and preserves non-session JSONL files", () => {
		const nonSessionFile = join(tempDir, "not-a-session.log");
		const originalContent = '{"type":"event","data":"not a session"}\n';
		writeFileSync(nonSessionFile, originalContent);

		expect(() => SessionHistory.open(nonSessionFile, tempDir)).toThrow(
			`Unknown session entry type "event" at ${nonSessionFile}:1`,
		);
		expect(readFileSync(nonSessionFile, "utf-8")).toBe(originalContent);
	});

	it("preserves explicit session file path when recovering from corrupted file", () => {
		const explicitPath = join(tempDir, "my-session.jsonl");
		writeFileSync(explicitPath, "");

		const sm = SessionHistory.open(explicitPath, tempDir);

		// The session file path should be preserved
		expect(sm.getSessionFile()).toBe(explicitPath);
	});

	it("subsequent loads share the session after its first message", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm1 = SessionHistory.open(emptyFile, tempDir);
		const sessionId = sm1.getSessionId();
		sm1.appendMessage(userMsg("hello"));

		const sm2 = SessionHistory.open(emptyFile, tempDir);
		expect(sm2.getSessionId()).toBe(sessionId);
		expect(sm2.getHeader()?.type).toBe("session");
	});
});

describe("SessionHistory session file creation", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-persist-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not create a file for a session with only setup entries", () => {
		const session = SessionHistory.create(tempDir, tempDir);
		session.appendModelChange("anthropic", "claude-sonnet-4-5");
		session.appendThinkingLevelChange("off");

		expect(existsSync(session.getSessionFile()!)).toBe(false);
	});

	// #10000: the first prompt must survive a first turn that never produces an assistant message
	it("creates the file when the first user message is appended", () => {
		const session = SessionHistory.create(tempDir, tempDir);
		session.appendModelChange("anthropic", "claude-sonnet-4-5");
		session.appendMessage(userMsg("first question"));

		const file = session.getSessionFile()!;
		expect(readSessionFileRoles(file)).toEqual(["session", "model_change", "user"]);
		expect(SessionHistory.open(file, tempDir).buildSessionContext().messages).toHaveLength(1);
	});

	it("appends later entries to the file without rewriting earlier ones", () => {
		const session = SessionHistory.create(tempDir, tempDir);
		session.appendMessage(userMsg("first question"));
		session.appendCustomEntry("preset-state", { name: "plan" });
		session.appendMessage(assistantMsg("first answer"));

		expect(readSessionFileRoles(session.getSessionFile()!)).toEqual(["session", "user", "custom", "assistant"]);
	});

	it("commits model and thinking entries together only after the journal write succeeds", () => {
		const session = SessionHistory.create(tempDir, tempDir);
		session.appendMessage(userMsg("first question"));
		const file = session.getSessionFile()!;
		const entries = session.getEntries();
		const leaf = session.getLeafId();
		rmSync(file);
		mkdirSync(file);

		expect(() => session.appendModelSelection("anthropic", "claude-sonnet-4-5", "high")).toThrow();
		expect(session.getEntries()).toEqual(entries);
		expect(session.getLeafId()).toBe(leaf);
	});

	it("links model and thinking entries in one selection commit", () => {
		const session = SessionHistory.create(tempDir, tempDir);
		const userEntryId = session.appendMessage(userMsg("first question"));
		const selection = session.appendModelSelection("anthropic", "claude-sonnet-4-5", "high");
		const modelEntry = session.getEntry(selection.modelChangeId);
		const thinkingEntry = session.getEntry(selection.thinkingLevelChangeId!);

		expect(modelEntry?.type).toBe("model_change");
		expect(modelEntry?.parentId).toBe(userEntryId);
		expect(thinkingEntry?.type).toBe("thinking_level_change");
		expect(thinkingEntry?.parentId).toBe(selection.modelChangeId);
		expect(session.getLeafId()).toBe(selection.thinkingLevelChangeId);
		expect(
			loadEntriesFromFile(session.getSessionFile()!)
				.slice(-2)
				.map((entry) => entry.id),
		).toEqual([selection.modelChangeId, selection.thinkingLevelChangeId]);
	});

	it("keeps the active leaf and projection when a branch summary cannot be written", () => {
		const session = SessionHistory.create(tempDir, tempDir);
		const first = session.appendMessage(userMsg("first"));
		const leaf = session.appendMessage(assistantMsg("answer"));
		const entries = session.getEntries();
		const projection = session.buildSessionProjection();
		const file = session.getSessionFile()!;
		rmSync(file);
		mkdirSync(file);

		expect(() => session.branchWithSummary(first, "summary")).toThrow();
		expect(session.getLeafId()).toBe(leaf);
		expect(session.getEntries()).toEqual(entries);
		expect(session.buildSessionProjection()).toBe(projection);
	});

	it("does not create a partial first log when setup data cannot be serialized", () => {
		const session = SessionHistory.create(tempDir, tempDir);
		const circular: { self?: unknown } = {};
		circular.self = circular;
		session.appendCustomEntry("circular", circular);
		const entries = session.getEntries();
		const leaf = session.getLeafId();

		expect(() => session.appendMessage(userMsg("first"))).toThrow();
		expect(existsSync(session.getSessionFile()!)).toBe(false);
		expect(session.getEntries()).toEqual(entries);
		expect(session.getLeafId()).toBe(leaf);
	});

	it("keeps the source identity when writing a fork fails", () => {
		const directory = join(tempDir, "sessions");
		mkdirSync(directory);
		const session = SessionHistory.create(tempDir, directory);
		const leaf = session.appendMessage(userMsg("source"));
		const id = session.getSessionId();
		const file = session.getSessionFile();
		const entries = session.getEntries();
		rmSync(file!);
		rmSync(directory, { recursive: true });
		writeFileSync(directory, "blocked");

		expect(() => session.createBranchedSession(leaf)).toThrow();
		expect(session.getSessionId()).toBe(id);
		expect(session.getSessionFile()).toBe(file);
		expect(session.getLeafId()).toBe(leaf);
		expect(session.getEntries()).toEqual(entries);
	});
});
