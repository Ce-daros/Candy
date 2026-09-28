import { setKeybindings } from "@candy/tui";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CommandMenu } from "../src/experimental/command-menu.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("experimental Command menu", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(KeybindingsManager.create());
	});

	test("searches by source and keeps failed arguments until cancelled", async () => {
		const run = vi.fn(async () => false);
		const close = vi.fn();
		const menu = new CommandMenu(
			[
				{ source: "local", name: "reload" },
				{ source: "plugin", name: "hello", argumentHint: "<name>" },
			],
			run,
			close,
		);
		menu.focused = true;
		menu.handleInput("plugin");
		expect(menu.render(80).join("\n")).toContain("hello");
		expect(menu.render(80).join("\n")).not.toContain("reload");
		menu.handleInput("\u001b[C");
		menu.handleInput("world");
		menu.handleInput("\r");
		await vi.waitFor(() =>
			expect(run).toHaveBeenCalledWith({ source: "plugin", name: "hello", argumentHint: "<name>" }, "world"),
		);
		expect(menu.render(80).join("\n")).toContain("world");
		expect(close).not.toHaveBeenCalled();
		menu.handleInput("\u001b");
		expect(menu.render(80).join("\n")).toContain("hello");
		menu.handleInput("\u001b");
		expect(close).toHaveBeenCalledOnce();
	});

	test("Enter runs a resource without arguments; Right opens its argument input", async () => {
		const run = vi.fn(async () => false);
		const item = { source: "skill", name: "review", argumentHint: "[focus]" };
		const menu = new CommandMenu([item], run, vi.fn());
		menu.focused = true;
		menu.handleInput("\r");
		await vi.waitFor(() => expect(run).toHaveBeenCalledWith(item, ""));
		menu.handleInput("\u001b[C");
		menu.handleInput("security");
		menu.handleInput("\r");
		await vi.waitFor(() => expect(run).toHaveBeenCalledWith(item, "security"));
	});

	test("Right opens arguments for a resource without an argument hint", async () => {
		const run = vi.fn(async () => false);
		const item = { source: "skill", name: "review" };
		const menu = new CommandMenu([item], run, vi.fn());
		menu.focused = true;
		menu.handleInput("\u001b[C");
		menu.handleInput("security");
		menu.handleInput("\r");
		await vi.waitFor(() => expect(run).toHaveBeenCalledWith(item, "security"));
	});

	test("cancelled execution cannot close the menu after its callback resolves", async () => {
		let complete!: (value: boolean) => void;
		const run = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					complete = resolve;
				}),
		);
		const close = vi.fn();
		const menu = new CommandMenu([{ source: "skill", name: "review" }], run, close);
		menu.focused = true;
		menu.handleInput("\r");
		menu.handleInput("\r");
		expect(run).toHaveBeenCalledOnce();
		menu.handleInput("\u001b");
		expect(close).toHaveBeenCalledOnce();
		complete(true);
		await Promise.resolve();
		expect(close).toHaveBeenCalledOnce();
	});

	test("backspace exits an empty search or returns from empty arguments", () => {
		const close = vi.fn();
		const menu = new CommandMenu(
			[{ source: "local", name: "compact", argumentHint: "<instructions>" }],
			() => true,
			close,
		);
		menu.focused = true;
		menu.handleInput("\r");
		menu.handleInput("\u007f");
		expect(close).not.toHaveBeenCalled();
		menu.handleInput("\u007f");
		expect(close).toHaveBeenCalledOnce();
	});
});
