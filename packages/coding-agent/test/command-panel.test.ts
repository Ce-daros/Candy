import { setKeybindings, visibleWidth } from "@candy/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CommandPanel, type CommandPanelAction } from "../src/modes/interactive/components/command-panel.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

describe("CommandPanel", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("searches duplicate names by source and executes the selected identity", async () => {
		const runSkill = vi.fn(async () => "message" as const);
		const runPrompt = vi.fn(async () => "message" as const);
		const onMessage = vi.fn();
		const actions: CommandPanelAction[] = [
			{ id: "prompt:plan", name: "plan", source: "Prompt", argumentMode: "none", execute: runPrompt },
			{ id: "skill:plan", name: "plan", source: "Skill", argumentMode: "none", execute: runSkill },
		];
		const panel = new CommandPanel(actions, { onCancel: vi.fn(), onMessage, requestRender: vi.fn() });
		for (const char of "skill") panel.handleInput(char);
		expect(panel.getQuery()).toBe("skill");
		expect(panel.getSelectedId()).toBe("skill:plan");
		panel.handleInput("\r");
		await flush();
		expect(runSkill).toHaveBeenCalledWith("");
		expect(runPrompt).not.toHaveBeenCalled();
		expect(onMessage).toHaveBeenCalledOnce();
	});

	it("keeps arguments after failure and returns one level at a time", async () => {
		const onCancel = vi.fn();
		const execute = vi.fn(async (args: string) => {
			if (args === "bad") throw new Error("Rejected");
			return "stay" as const;
		});
		const panel = new CommandPanel(
			[{ id: "import", name: "Import", argumentMode: "multiple", argumentHint: "Path and options", execute }],
			{ onCancel, onMessage: vi.fn(), requestRender: vi.fn() },
		);
		panel.handleInput("\r");
		for (const char of "bad") panel.handleInput(char);
		panel.handleInput("\r");
		await flush();
		expect(execute).toHaveBeenCalledWith("bad");
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("Rejected");
		panel.handleInput("\x7f");
		expect(stripAnsi(panel.render(80).join("\n"))).not.toContain("Rejected");
		panel.handleInput("\x1b");
		expect(panel.getSelectedId()).toBe("import");
		expect(onCancel).not.toHaveBeenCalled();
		panel.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("lets Escape abandon pending execution without a late completion callback", async () => {
		let resolve: (value: "message") => void = () => {};
		const done = new Promise<"message">((complete) => {
			resolve = complete;
		});
		const onCancel = vi.fn();
		const onMessage = vi.fn();
		const panel = new CommandPanel([{ id: "go", name: "Go", argumentMode: "none", execute: () => done }], {
			onCancel,
			onMessage,
			requestRender: vi.fn(),
		});
		panel.handleInput("\r");
		panel.handleInput("\x1b");
		resolve("message");
		await flush();
		expect(onCancel).toHaveBeenCalledOnce();
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("preserves search selection when actions refresh", () => {
		const first: CommandPanelAction = { id: "first", name: "First", argumentMode: "none", execute: async () => {} };
		const second: CommandPanelAction = {
			id: "second",
			name: "Second",
			argumentMode: "none",
			execute: async () => {},
		};
		const panel = new CommandPanel([first, second], {
			title: "History",
			description: "Current session",
			onCancel: vi.fn(),
			onMessage: vi.fn(),
			requestRender: vi.fn(),
		});
		panel.handleInput("\x1b[B");
		expect(panel.getSelectedId()).toBe("second");
		panel.setActions([second, first]);
		expect(panel.getSelectedId()).toBe("second");
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("Current session");
	});

	it("keeps argument failures across a child dialog", async () => {
		let reject!: (error: Error) => void;
		const pending = new Promise<void>((_resolve, fail) => {
			reject = fail;
		});
		const panel = new CommandPanel(
			[{ id: "import", name: "Import", argumentMode: "single", execute: () => pending }],
			{
				onCancel: vi.fn(),
				onMessage: vi.fn(),
				requestRender: vi.fn(),
			},
		);
		panel.handleInput("\r");
		panel.handleInput("missing.jsonl");
		panel.handleInput("\r");
		panel.suspend();
		reject(new Error("Could not import"));
		await flush();
		panel.resume();
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("missing.jsonl");
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("Could not import");
	});

	it("runs optional commands directly and opens arguments with Right", async () => {
		const execute = vi.fn(async () => {});
		const panel = new CommandPanel([{ id: "skill:review", name: "review", argumentMode: "optional", execute }], {
			onCancel: vi.fn(),
			onMessage: vi.fn(),
			requestRender: vi.fn(),
		});
		panel.handleInput("review");
		panel.handleInput("\r");
		await flush();
		expect(execute).toHaveBeenLastCalledWith("");
		panel.handleInput("\x1b[C");
		panel.handleInput('"two words" --strict');
		panel.handleInput("\r");
		await flush();
		expect(execute).toHaveBeenLastCalledWith('"two words" --strict');
		expect(panel.getQuery()).toBe("review");
	});

	it("separates checkbox navigation from multiword search and scopes bulk keys to matching rows", async () => {
		const toggle = vi.fn(async () => {});
		const selection = vi.fn();
		const panel = new CommandPanel(
			[
				{ id: "first", name: "First model", checked: false, argumentMode: "none", execute: toggle },
				{ id: "second", name: "Second model", checked: true, argumentMode: "none", execute: toggle },
			],
			{ onCancel: vi.fn(), onMessage: vi.fn(), requestRender: vi.fn(), onSelectionChange: selection },
		);
		panel.handleInput(" ");
		await flush();
		expect(toggle).toHaveBeenCalledOnce();
		expect(panel.getQuery()).toBe("");
		for (const char of "First model") panel.handleInput(char);
		expect(panel.getQuery()).toBe("First model");
		panel.handleInput("\x01");
		expect(selection).toHaveBeenLastCalledWith(["first"], true);
		panel.handleInput("\x04");
		expect(selection).toHaveBeenLastCalledWith(["first"], false);
		panel.handleInput("\x1b[B");
		panel.handleInput(" ");
		await flush();
		expect(toggle).toHaveBeenCalledTimes(2);
	});

	it("retains arguments when a child action is cancelled", async () => {
		const panel = new CommandPanel(
			[{ id: "import", name: "Import", argumentMode: "single", execute: async () => "edit" as const }],
			{
				onCancel: vi.fn(),
				onMessage: vi.fn(),
				requestRender: vi.fn(),
			},
		);
		panel.handleInput("\r");
		panel.handleInput("session.jsonl");
		panel.handleInput("\r");
		await flush();
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("> session.jsonl");
	});

	it("moves focus between checkbox rows and search with the mouse", async () => {
		const toggle = vi.fn(async () => {});
		const panel = new CommandPanel(
			[{ id: "model", name: "Model", checked: true, argumentMode: "none", execute: toggle }],
			{
				onCancel: vi.fn(),
				onMessage: vi.fn(),
				requestRender: vi.fn(),
				onSelectionChange: vi.fn(),
			},
		);
		panel.focused = true;
		panel.handleInput("Model");
		const rendered = stripAnsi(panel.render(80).join("\n")).split("\n");
		const modelRow = rendered.findIndex((line) => line.includes("♦ [x] Model"));
		const mouse = {
			type: "press" as const,
			button: "left" as const,
			x: 5,
			screenX: 5,
			screenY: 4,
			width: 80,
			height: 20,
			shift: false,
			alt: false,
			ctrl: false,
		};
		panel.handleMouse({ ...mouse, y: modelRow });
		panel.handleInput(" ");
		await flush();
		expect(toggle).toHaveBeenCalledOnce();
		expect(panel.getQuery()).toBe("Model");
		const searchRow = stripAnsi(panel.render(80).join("\n"))
			.split("\n")
			.findIndex((line) => line.includes("/ "));
		panel.handleMouse({ ...mouse, x: 20, y: searchRow });
		panel.handleInput(" ");
		expect(panel.getQuery()).toBe("Model ");
	});

	it("renders groups, status tones, and runs setting cycle/reset actions in place", async () => {
		const cycle = vi.fn(async (_direction: 1 | -1) => {});
		const reset = vi.fn(async () => {});
		const panel = new CommandPanel(
			[
				{
					id: "grouped",
					name: "Transport",
					group: "Connection",
					status: { text: "Not connected", tone: "error" },
					cycle,
					reset,
					inline: true,
					argumentMode: "none",
					execute: vi.fn(),
				},
			],
			{ title: "Settings", searchable: false, onCancel: vi.fn(), onMessage: vi.fn(), requestRender: vi.fn() },
		);
		const output = stripAnsi(panel.render(80).join("\n"));
		expect(output).toContain("Connection");
		expect(output).toContain("Not connected");
		expect(output).not.toContain("Search:");
		panel.handleInput("\x1b[C");
		await flush();
		expect(cycle).toHaveBeenCalledWith(1);
		panel.handleInput("\x1b[3~");
		await flush();
		expect(reset).toHaveBeenCalledOnce();
	});

	it("edits inline arguments on the selected row and preserves selection on cancel", () => {
		const execute = vi.fn(async () => "stay" as const);
		const panel = new CommandPanel(
			[{ id: "timeout", name: "Timeout", inline: true, initialArgs: "5", argumentMode: "single", execute }],
			{ title: "Settings", searchable: false, onCancel: vi.fn(), onMessage: vi.fn(), requestRender: vi.fn() },
		);
		panel.handleInput("\r");
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("Timeout");
		panel.handleInput("1");
		const editing = panel.render(80).join("\n");
		expect(stripAnsi(editing)).toContain("Timeout");
		expect(editing).toContain("\x1b[7m");
		expect(editing.split("\n").every((line) => visibleWidth(line) <= 80)).toBe(true);
		panel.handleInput("\x1b");
		const cancelled = stripAnsi(panel.render(80).join("\n"));
		expect(cancelled).toContain("Timeout");
		expect(cancelled).not.toContain("> 51");
		panel.handleInput("\r");
		panel.handleInput("1");
		panel.handleInput("\r");
		expect(execute).toHaveBeenCalledWith("51");
		expect(panel.getSelectedId()).toBe("timeout");
	});

	it("cycles settings from the selected row while search remains available", async () => {
		const cycle = vi.fn(async (_direction: 1 | -1) => {});
		const panel = new CommandPanel([{ id: "mode", name: "Mode", cycle, argumentMode: "none", execute: vi.fn() }], {
			title: "Settings",
			onCancel: vi.fn(),
			onMessage: vi.fn(),
			requestRender: vi.fn(),
		});
		panel.handleInput("\x1b[B");
		panel.handleInput("\x1b[C");
		await flush();
		expect(cycle).toHaveBeenCalledWith(1);
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("Search:");
	});

	it("keeps a provider status beside the complete option label at 80 and 100 columns", () => {
		const panel = new CommandPanel(
			[
				{
					id: "auth",
					name: "Check authentication",
					status: { text: "Not connected", tone: "error" },
					argumentMode: "none",
					execute: vi.fn(),
				},
			],
			{ onCancel: vi.fn(), onMessage: vi.fn(), requestRender: vi.fn() },
		);
		for (const width of [80, 100]) {
			const output = stripAnsi(panel.render(width).join("\n"));
			expect(output).toContain("Check authentication");
			expect(output).toContain("Not connected");
		}
	});

	it("does not clip longer settings labels in the primary column", () => {
		const panel = new CommandPanel(
			[
				{
					id: "recent",
					name: "Keep recent tokens",
					description: "20000 · default · Saved: Inherited",
					argumentMode: "none",
					execute: vi.fn(),
				},
			],
			{ title: "Details", searchable: false, onCancel: vi.fn(), onMessage: vi.fn(), requestRender: vi.fn() },
		);
		for (const width of [80, 100]) expect(stripAnsi(panel.render(width).join("\n"))).toContain("Keep recent tokens");
	});

	it("wraps long status details and scrolls them without changing the selected action", () => {
		const detail = Array.from({ length: 12 }, (_, index) => `Cause ${index}`).join(" ");
		const panel = new CommandPanel(
			[
				{
					id: "auth",
					name: "Authentication",
					status: { text: "Not connected", tone: "error", detail },
					argumentMode: "none",
					execute: vi.fn(),
				},
			],
			{ onCancel: vi.fn(), onMessage: vi.fn(), requestRender: vi.fn() },
		);
		panel.setAvailableHeight(8);
		const initial = stripAnsi(panel.render(40).join("\n"));
		expect(initial).toContain("Cause 0");
		expect(initial).not.toContain("Cause 11");
		panel.handleInput("\t");
		panel.handleInput("\x1b[B");
		panel.handleInput("\x1b[B");
		const later = stripAnsi(panel.render(40).join("\n"));
		expect(later).toContain("Cause 11");
		expect(panel.getSelectedId()).toBe("auth");
	});
});
