import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultSessionDirPath } from "../../src/core/session-discovery.ts";
import { SessionDiscovery, SessionHistory, type SessionInfo } from "../../src/core/session-history.ts";
import { userMsg } from "../utilities.ts";

describe("colliding default session directories", () => {
	let directory: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "candy-session-collision-"));
		vi.stubEnv("CANDY_CODING_AGENT_DIR", join(directory, "agent"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	it("scopes discovery and continuation to the header cwd even when paths encode identically", async () => {
		const projectA = join(directory, "a-b", "c");
		const projectB = join(directory, "a", "b-c");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
		const sessionDir = getDefaultSessionDirPath(projectA);
		expect(getDefaultSessionDirPath(projectB)).toBe(sessionDir);
		const sessionA = SessionHistory.create(projectA);
		sessionA.appendMessage(userMsg("private context from A"));
		const fileA = sessionA.getSessionFile()!;

		for (const explicitDirectory of [undefined, sessionDir]) {
			expect(await SessionDiscovery.list(projectB, explicitDirectory)).toEqual([]);
			expect(SessionDiscovery.findById(projectB, sessionA.getSessionId(), explicitDirectory)).toBeUndefined();
			expect(SessionHistory.continueRecent(projectB, explicitDirectory).getSessionId()).not.toBe(
				sessionA.getSessionId(),
			);
		}
		const sessionB = SessionHistory.create(projectB);
		sessionB.appendMessage(userMsg("context from B"));
		const fileB = sessionB.getSessionFile()!;
		// A is the most recently modified file in their shared encoded directory.
		const newer = new Date(Date.now() + 10_000);
		utimesSync(fileA, newer, newer);

		for (const explicitDirectory of [undefined, sessionDir]) {
			const partialSessions: SessionInfo[] = [];
			const listed = await SessionDiscovery.list(projectB, explicitDirectory, (_loaded, _total, partial) => {
				if (partial) partialSessions.push(...partial);
			});
			expect(listed.map((session) => session.path)).toEqual([fileB]);
			expect(partialSessions.every((session) => session.cwd === projectB)).toBe(true);
			expect(SessionDiscovery.findById(projectB, sessionB.getSessionId(), explicitDirectory)).toBe(fileB);
			expect(SessionDiscovery.findById(projectB, sessionA.getSessionId(), explicitDirectory)).toBeUndefined();
			expect(SessionHistory.continueRecent(projectB, explicitDirectory).getSessionFile()).toBe(fileB);
		}
		expect((await SessionDiscovery.list(projectA)).map((session) => session.path)).toEqual([fileA]);
		expect(new Set((await SessionDiscovery.listAll()).map((session) => session.path))).toEqual(
			new Set([fileA, fileB]),
		);
	});
});
