import { setKeybindings } from "@candy/tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../src/core/session-history.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { KeybindingsManager } from "../src/presentation/keybindings.ts";

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
	};
}

// Kitty keyboard protocol encoding for Ctrl+R
const CTRL_R = "\x1b[114;5u";

describe("session selector rename", () => {
	it("keeps the draft and reports a failed save so it can be retried", async () => {
		const sessions = [makeSession({ id: "a", name: "Old" })];
		const renameSession = vi
			.fn()
			.mockRejectedValueOnce(new Error("Permission denied"))
			.mockResolvedValueOnce(undefined);
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ renameSession },
		);
		await flushPromises();
		selector.focused = true;
		selector.handleInput(CTRL_R);
		selector.handleInput("中文");
		selector.handleInput("\r");
		await flushPromises();
		expect(selector.render(80).join("\n")).toContain("Permission denied");
		expect(selector.render(80).join("\n")).toContain("Old中文");
		selector.handleInput("\r");
		await flushPromises();
		expect(renameSession).toHaveBeenCalledTimes(2);
		selector.dispose();
	});

	it.each(["cancel", "dispose"])("ignores pending save completion after %s", async (action) => {
		const sessions = [makeSession({ id: "a", name: "Old" })];
		let complete!: () => void;
		const renameSession = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					complete = resolve;
				}),
		);
		const render = vi.fn();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			render,
			{ renameSession },
		);
		await flushPromises();
		selector.handleInput(CTRL_R);
		selector.handleInput("\r");
		selector.handleInput("\r");
		expect(renameSession).toHaveBeenCalledOnce();
		if (action === "cancel") selector.handleInput("\x1b");
		else selector.dispose();
		render.mockClear();
		complete();
		await flushPromises();
		expect(render).not.toHaveBeenCalled();
		selector.dispose();
	});
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	it("shows rename hint in the interactive History picker", async () => {
		const sessions = [makeSession({ id: "a" })];
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ showRenameHint: true, keybindings },
		);
		await flushPromises();

		const output = selector.render(120).join("\n");
		expect(output).toContain("<Ctrl+R>");
		expect(output).toContain("rename");
	});

	it("does not show rename hint in --resume picker configuration", async () => {
		const sessions = [makeSession({ id: "a" })];
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ showRenameHint: false, keybindings },
		);
		await flushPromises();

		const output = selector.render(120).join("\n");
		expect(output).not.toContain("<Ctrl+R>");
		expect(output).not.toContain("rename");
	});

	it("enters rename mode on Ctrl+R and submits with Enter", async () => {
		const sessions = [makeSession({ id: "a", name: "Old" })];
		const renameSession = vi.fn(async () => {});

		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ renameSession, showRenameHint: true, keybindings },
		);
		await flushPromises();

		selector.getSessionList().handleInput(CTRL_R);
		await flushPromises();

		// Rename mode layout
		const output = selector.render(120).join("\n");
		expect(output).toContain("Rename Session");
		expect(output).toContain("Resume Session");
		expect(output).not.toContain("<Ctrl+R>");
		expect(output).not.toContain("regex");

		// Type and submit
		selector.handleInput("X");
		selector.handleInput("\r");
		await flushPromises();

		expect(renameSession).toHaveBeenCalledTimes(1);
		expect(renameSession).toHaveBeenCalledWith(sessions[0]!.path, "OldX");
		selector.dispose();
	});

	it("keeps the browser header position and restores its search and selection after cancelling", async () => {
		const sessions = [makeSession({ id: "a", name: "Old" }), makeSession({ id: "b", name: "Other" })];
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ renameSession: vi.fn(async () => {}) },
		);
		await flushPromises();
		selector.focused = true;
		selector.handleInput("Old");
		const before = selector.render(120);
		selector.handleInput(CTRL_R);
		const editing = selector.render(120);
		expect(editing.length).toBe(before.length);
		expect(editing[0]).toBe(before[0]);
		expect(editing[4]).toContain("Rename Session");
		selector.handleInput("\x1b");
		expect(selector.render(120)).toEqual(before);
		selector.dispose();
	});
});
