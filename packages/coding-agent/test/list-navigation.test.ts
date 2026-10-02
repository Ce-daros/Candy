import { resolve } from "node:path";
import { setKeybindings, type TuiMouseEvent } from "@candy/tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionTreeNode } from "../src/core/session-history.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	ConfigSelectorComponent,
	type ScopedResolvedPaths,
} from "../src/modes/interactive/components/config-selector.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { FirstTimeSetupComponent } from "../src/modes/interactive/components/first-time-setup.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { ReadingPanelComponent } from "../src/modes/interactive/components/reading-panel.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { KeybindingsManager } from "../src/presentation/keybindings.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const ENTER = "\r";
const wheel = (delta: number): TuiMouseEvent => ({
	type: "wheel",
	button: "none",
	x: 0,
	y: 0,
	screenX: 0,
	screenY: 0,
	width: 80,
	height: 24,
	shift: false,
	alt: false,
	ctrl: false,
	wheelDelta: delta,
});

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager({ "app.panel.focusPrevious": "shift+tab" })));

describe("vertical list navigation", () => {
	it.each([0, 1])("handles %s session, tree, OAuth, resource and message rows", async (count) => {
		const select = vi.fn();
		const sessions: SessionInfo[] = Array.from({ length: count }, () => ({
			path: "/tmp/only.jsonl",
			id: "only",
			cwd: "/demo",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 1,
			firstMessage: "Only",
			allMessagesText: "Only",
		}));
		const session = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			select,
			vi.fn(),
			vi.fn(),
			vi.fn(),
			{ keybindings: new KeybindingsManager() },
		);
		await new Promise<void>((done) => setImmediate(done));
		const tree: SessionTreeNode[] = Array.from({ length: count }, () => ({
			entry: {
				type: "message",
				id: "only",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: "Only", timestamp: 0 },
			},
			children: [],
		}));
		const oauth = new OAuthSelectorComponent(
			"login",
			Array.from({ length: count }, () => ({ id: "only", name: "Only", authType: "api_key" })),
			select,
			vi.fn(),
		);
		const treeSelector = new TreeSelectorComponent(tree, count ? "only" : null, 24, select, vi.fn());
		const messages = new UserMessageSelectorComponent(
			Array.from({ length: count }, () => ({ id: "only", text: "Only" })),
			select,
			vi.fn(),
		);
		const empty = { extensions: [], skills: [], prompts: [], themes: [] };
		const resources: ScopedResolvedPaths = {
			global: {
				...empty,
				skills: Array.from({ length: count }, () => ({
					path: "C:/demo/only/SKILL.md",
					enabled: true,
					metadata: { source: "auto", scope: "user", origin: "top-level" },
				})),
			},
			project: empty,
		};
		const resource = new ConfigSelectorComponent(
			resources,
			SettingsManager.inMemory(),
			"C:/demo",
			"C:/demo",
			vi.fn(),
			vi.fn(),
			vi.fn(),
			24,
			"global",
			false,
			undefined,
			{ resourceTypes: ["skills"], onOpen: select },
		);
		for (const component of [session, treeSelector, oauth, messages, resource]) {
			component.handleInput(UP);
			component.handleInput(DOWN);
			component.render(80);
			component.handleInput(ENTER);
		}
		expect(select).toHaveBeenCalledTimes(count * 5);
		session.dispose();
	});
	it("wraps extension choices while keeping horizontal arrows bounded", () => {
		const select = vi.fn();
		const vertical = new ExtensionSelectorComponent("Choose", ["first", "last"], select, vi.fn());
		vertical.handleInput(UP);
		vertical.handleInput(ENTER);
		expect(select).toHaveBeenLastCalledWith("last");
		vertical.handleInput(DOWN);
		vertical.handleInput(ENTER);
		expect(select).toHaveBeenLastCalledWith("first");
		const horizontal = new ExtensionSelectorComponent("Choose", ["first", "last"], select, vi.fn(), {
			horizontal: true,
		});
		horizontal.handleInput("\x1b[D");
		horizontal.handleInput(ENTER);
		expect(select).toHaveBeenLastCalledWith("first");
		horizontal.handleInput("\x1b[C");
		horizontal.handleInput("\x1b[C");
		horizontal.handleInput(ENTER);
		expect(select).toHaveBeenLastCalledWith("last");
	});

	it.each([{ choices: [] }, { choices: ["only"] }])("handles extension results $choices", ({ choices }) => {
		const select = vi.fn();
		const selector = new ExtensionSelectorComponent("Choose", choices, select, vi.fn());
		selector.handleInput(UP);
		selector.handleInput(DOWN);
		selector.handleInput(ENTER);
		if (choices.length === 0) expect(select).not.toHaveBeenCalled();
		else expect(select).toHaveBeenCalledWith("only");
	});

	it("wraps OAuth providers within search results", () => {
		const select = vi.fn();
		const selector = new OAuthSelectorComponent(
			"login",
			[
				{ id: "first", name: "Match first", authType: "api_key" },
				{ id: "other", name: "Other", authType: "api_key" },
				{ id: "last", name: "Match last", authType: "api_key" },
			],
			select,
			vi.fn(),
		);
		selector.handleInput("Match");
		selector.handleInput(UP);
		selector.handleInput(ENTER);
		expect(select).toHaveBeenLastCalledWith("last", "api_key");
		selector.handleInput(DOWN);
		selector.handleInput(ENTER);
		expect(select).toHaveBeenLastCalledWith("first", "api_key");
	});

	it("wraps trust choices and theme previews", () => {
		const select = vi.fn();
		const trust = new TrustSelectorComponent({
			cwd: resolve("/demo/project"),
			savedDecision: null,
			projectTrusted: false,
			onSelect: select,
			onCancel: vi.fn(),
		});
		trust.handleInput(UP);
		trust.handleInput(ENTER);
		expect(select.mock.lastCall?.[0]).toEqual({ trusted: false, updates: [] });
		trust.handleInput(DOWN);
		trust.handleInput(ENTER);
		expect(select.mock.lastCall?.[0]).toEqual({
			trusted: true,
			updates: [{ path: resolve("/demo/project"), decision: true }],
		});
		const preview = vi.fn();
		const setup = new FirstTimeSetupComponent({
			detectedTheme: "dark",
			onThemePreview: preview,
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
		});
		setup.handleInput(UP);
		setup.handleInput(DOWN);
		expect(preview.mock.calls).toEqual([["light"], ["dark"]]);
	});

	it("wraps resource rows across headers and category boundaries", () => {
		const open = vi.fn();
		const metadata = { source: "auto", scope: "user", origin: "top-level", baseDir: "C:/demo" } as const;
		const empty = { extensions: [], skills: [], prompts: [], themes: [] };
		const resolved: ScopedResolvedPaths = {
			global: {
				...empty,
				skills: [
					{ path: "C:/demo/a/SKILL.md", enabled: true, metadata },
					{ path: "C:/demo/z/SKILL.md", enabled: true, metadata },
				],
			},
			project: empty,
		};
		const selector = new ConfigSelectorComponent(
			resolved,
			SettingsManager.inMemory(),
			"C:/demo",
			"C:/demo",
			vi.fn(),
			vi.fn(),
			vi.fn(),
			30,
			"global",
			false,
			undefined,
			{ resourceTypes: ["skills", "themes"], onOpen: open },
		);
		selector.handleInput(UP);
		selector.handleInput(ENTER);
		expect(open).toHaveBeenLastCalledWith("C:/demo/z/SKILL.md");
		selector.handleInput(DOWN);
		selector.handleInput(ENTER);
		expect(open).toHaveBeenLastCalledWith("C:/demo/a/SKILL.md");
		selector.handleInput("\x1b[Z");
		selector.handleInput(UP);
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("♦ Themes ♦");
		selector.handleInput(DOWN);
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("♦ Skills ♦");
	});

	it("wraps session selection while pages, wheel and detail keys stay bounded", async () => {
		const sessions: SessionInfo[] = ["first", "last"].map((id) => ({
			path: `/tmp/${id}.jsonl`,
			id,
			cwd: "/demo",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 1,
			firstMessage: id,
			allMessagesText: id,
		}));
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			vi.fn(),
			vi.fn(),
			vi.fn(),
			vi.fn(),
			{ keybindings: new KeybindingsManager() },
		);
		await new Promise<void>((done) => setImmediate(done));
		const list = selector.getSessionList();
		list.handleInput(UP);
		expect(list.getSelectedSessionPath()).toBe(sessions[1].path);
		list.handleInput(PAGE_DOWN);
		list.handleMouse(wheel(1));
		expect(list.getSelectedSessionPath()).toBe(sessions[1].path);
		list.handleInput(DOWN);
		expect(list.getSelectedSessionPath()).toBe(sessions[0].path);
		list.handleInput(PAGE_UP);
		expect(list.getSelectedSessionPath()).toBe(sessions[0].path);
		list.handleInput("\t");
		list.handleInput(UP);
		expect(list.getSelectedSessionPath()).toBe(sessions[0].path);
		selector.dispose();
	});

	it("wraps tree selection and preserves page and detail navigation", () => {
		const tree: SessionTreeNode[] = ["first", "last"].map((id) => ({
			entry: {
				type: "message",
				id,
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: id, timestamp: 0 },
			},
			children: [],
		}));
		const selector = new TreeSelectorComponent(tree, "first", 24, vi.fn(), vi.fn());
		const list = selector.getTreeList();
		list.handleInput(UP);
		expect(list.getSelectedNode()?.entry.id).toBe("last");
		list.handleInput(PAGE_DOWN);
		list.handleMouse(wheel(1));
		expect(list.getSelectedNode()?.entry.id).toBe("last");
		list.handleInput(DOWN);
		list.handleInput(PAGE_UP);
		expect(list.getSelectedNode()?.entry.id).toBe("first");
		list.handleInput("\t");
		list.handleInput(UP);
		expect(list.getSelectedNode()?.entry.id).toBe("first");
	});

	it("wraps user messages while preview input and blank mouse rows preserve selection", () => {
		const select = vi.fn();
		const selector = new UserMessageSelectorComponent(
			[
				{ id: "first", text: "First" },
				{ id: "last", text: "Last" },
			],
			select,
			vi.fn(),
			"first",
		);
		selector.handleInput(UP);
		selector.handleInput(ENTER);
		expect(select).toHaveBeenLastCalledWith("last");
		selector.handleInput(DOWN);
		selector.handleInput("\t");
		selector.handleInput(UP);
		selector.handleInput(ENTER);
		expect(select).toHaveBeenLastCalledWith("first");
		selector.handleInput("\t");
		selector.setAvailableHeight(24);
		selector.render(80);
		selector.handleMouse({ ...wheel(0), type: "click", button: "left", y: 7 });
		selector.handleInput(ENTER);
		expect(select).toHaveBeenLastCalledWith("first");
	});

	it("wraps ReadingPanel results and keeps pages and text scrolling bounded", () => {
		const rows = [
			{ category: "Actions", label: "First", value: "a" },
			{ category: "Actions", label: "Last", value: "z" },
		];
		const panel = new ReadingPanelComponent("Hotkeys", "", vi.fn(), rows);
		panel.handleInput(UP);
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("♦ Last");
		panel.handleInput(PAGE_DOWN);
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("♦ Last");
		panel.handleInput(DOWN);
		panel.handleInput(PAGE_UP);
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("♦ First");
		const text = new ReadingPanelComponent(
			"Text",
			Array.from({ length: 30 }, (_, index) => `Line ${index}`).join("\n\n"),
			vi.fn(),
		);
		text.setAvailableHeight(8);
		const initial = text.render(80);
		text.handleInput(UP);
		expect(text.render(80)).toEqual(initial);
	});
});
