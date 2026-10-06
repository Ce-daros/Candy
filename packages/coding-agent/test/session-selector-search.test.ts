import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@candy/tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/core/session-history.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { filterAndSortSessions } from "../src/modes/interactive/components/session-selector-search.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { KeybindingsManager } from "../src/presentation/keybindings.ts";

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

describe("session selector search feedback", () => {
	it("shows invalid regex errors and the actual search sort, then restores threaded browsing", async () => {
		const sessions = [makeSession({ id: "a", modified: new Date(0), allMessagesText: "hello" })];
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			expect(stripVTControlCharacters(selector.render(120).join("\n"))).toContain("Sort: Threaded");
			selector.handleInput("re:[");
			const invalid = stripVTControlCharacters(selector.render(120).join("\n"));
			expect(invalid).toContain("Invalid regex:");
			expect(invalid).toContain("Sort: Fuzzy");
			expect(invalid).not.toContain("No sessions in current folder");
			selector.handleInput("\x15");
			expect(stripVTControlCharacters(selector.render(120).join("\n"))).toContain("Sort: Threaded");
			selector.handleInput("missing");
			expect(stripVTControlCharacters(selector.render(120).join("\n"))).toContain('No sessions match "missing"');
		} finally {
			selector.dispose();
		}
	});

	it("keeps valid sessions selectable while showing scrollable file errors", async () => {
		const sessions = [makeSession({ id: "valid", modified: new Date(0), allMessagesText: "hello" })];
		let selected: string | undefined;
		const selector = new SessionSelectorComponent(
			async (progress) => {
				progress?.(2, 2, sessions, [
					{ path: "/tmp/broken.jsonl", message: "Invalid session JSON at /tmp/broken.jsonl:4" },
				]);
				return sessions;
			},
			async () => [],
			(path) => {
				selected = path;
			},
			() => {},
			() => {},
			() => {},
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			const rendered = stripVTControlCharacters(selector.render(80).join("\n"));
			expect(rendered).toContain("1 session file(s) could not be read");
			expect(rendered).toContain("/tmp/broken.jsonl");
			expect(rendered).toContain("Invalid session JSON at /tmp/broken.jsonl:4");
			expect(selector.render(80)).toHaveLength(24);
			selector.handleInput("\r");
			expect(selected).toBe("/tmp/valid.jsonl");
		} finally {
			selector.dispose();
		}
	});

	it("keeps a directory load error visible until the user leaves", async () => {
		const selector = new SessionSelectorComponent(
			async () => {
				throw new Error("Directory access denied");
			},
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			expect(stripVTControlCharacters(selector.render(80).join("\n"))).toContain("Directory access denied");
			expect(selector.render(80)).toHaveLength(24);
		} finally {
			selector.dispose();
		}
	});
});

function makeSession(
	overrides: Partial<SessionInfo> & { id: string; modified: Date; allMessagesText: string },
): SessionInfo {
	return {
		path: `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified,
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "(no messages)",
		allMessagesText: overrides.allMessagesText,
	};
}

describe("session selector search", () => {
	it("filters by quoted phrase with whitespace normalization", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "a",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "node\n\n   cve was discussed",
			}),
			makeSession({
				id: "b",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				allMessagesText: "node something else",
			}),
		];

		const result = filterAndSortSessions(sessions, '"node cve"', "recent");
		expect(result.map((s) => s.id)).toEqual(["a"]);
	});

	it("filters by regex (re:) and is case-insensitive", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "a",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				allMessagesText: "Brave is great",
			}),
			makeSession({
				id: "b",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "bravery is not the same",
			}),
		];

		const result = filterAndSortSessions(sessions, "re:\\bbrave\\b", "recent");
		expect(result.map((s) => s.id)).toEqual(["a"]);
	});

	it("recent sort preserves input order", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "newer",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
			makeSession({
				id: "older",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
			makeSession({
				id: "nomatch",
				modified: new Date("2026-01-04T00:00:00.000Z"),
				allMessagesText: "something else",
			}),
		];

		const result = filterAndSortSessions(sessions, '"brave"', "recent");
		expect(result.map((s) => s.id)).toEqual(["newer", "older"]);
	});

	it("relevance sort orders by score and tie-breaks by modified desc", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "late",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "xxxx brave",
			}),
			makeSession({
				id: "early",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "brave xxxx",
			}),
		];

		const result1 = filterAndSortSessions(sessions, '"brave"', "relevance");
		expect(result1.map((s) => s.id)).toEqual(["early", "late"]);

		const tieSessions: SessionInfo[] = [
			makeSession({
				id: "newer",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
			makeSession({
				id: "older",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
		];

		const result2 = filterAndSortSessions(tieSessions, '"brave"', "relevance");
		expect(result2.map((s) => s.id)).toEqual(["newer", "older"]);
	});

	it("returns empty list for invalid regex", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "a",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "brave",
			}),
		];

		const result = filterAndSortSessions(sessions, "re:(", "recent");
		expect(result).toEqual([]);
	});

	describe("name filter", () => {
		const sessions: SessionInfo[] = [
			makeSession({
				id: "named1",
				name: "My Project",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				allMessagesText: "blueberry",
			}),
			makeSession({
				id: "named2",
				name: "Another Named",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				allMessagesText: "blueberry",
			}),
			makeSession({
				id: "other1",
				modified: new Date("2026-01-04T00:00:00.000Z"),
				allMessagesText: "blueberry",
			}),
			makeSession({
				id: "other2",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				allMessagesText: "blueberry",
			}),
		];

		it("returns all sessions when nameFilter is 'all'", () => {
			const result = filterAndSortSessions(sessions, "", "recent", "all");
			expect(result.map((session) => session.id)).toEqual(["named1", "named2", "other1", "other2"]);
		});

		it("returns only named sessions when nameFilter is 'named'", () => {
			const result = filterAndSortSessions(sessions, "", "recent", "named");
			expect(result.map((session) => session.id)).toEqual(["named1", "named2"]);
		});

		it("applies name filter before search query", () => {
			const result = filterAndSortSessions(sessions, "blueberry", "recent", "named");
			expect(result.map((session) => session.id)).toEqual(["named1", "named2"]);
		});

		it("excludes whitespace-only names from named filter", () => {
			const sessionsWithWhitespace: SessionInfo[] = [
				makeSession({
					id: "whitespace",
					name: "   ",
					modified: new Date("2026-01-01T00:00:00.000Z"),
					allMessagesText: "test",
				}),
				makeSession({
					id: "empty",
					name: "",
					modified: new Date("2026-01-02T00:00:00.000Z"),
					allMessagesText: "test",
				}),
				makeSession({
					id: "named",
					name: "Real Name",
					modified: new Date("2026-01-03T00:00:00.000Z"),
					allMessagesText: "test",
				}),
			];

			const result = filterAndSortSessions(sessionsWithWhitespace, "", "recent", "named");
			expect(result.map((session) => session.id)).toEqual(["named"]);
		});
	});
});
