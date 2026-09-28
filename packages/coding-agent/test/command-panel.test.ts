import { setKeybindings } from "@candy/tui";
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
		panel.render(80);
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
		panel.handleMouse({ ...mouse, y: 4 });
		panel.handleInput(" ");
		await flush();
		expect(toggle).toHaveBeenCalledOnce();
		expect(panel.getQuery()).toBe("Model");
		panel.handleMouse({ ...mouse, x: 20, y: 2 });
		panel.handleInput(" ");
		expect(panel.getQuery()).toBe("Model ");
	});
});
