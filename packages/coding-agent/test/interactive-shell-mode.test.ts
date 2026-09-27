import { describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ShellMode = "normal" | "shell" | "shell-no-context";

type ShellContext = {
	shellMode: ShellMode;
	editor: { getText(): string };
	defaultEditor: {
		getText(): string;
		setHistoryScope: ReturnType<typeof vi.fn>;
		setShellMode: ReturnType<typeof vi.fn>;
	};
	keybindings: KeybindingsManager;
	setShellMode(mode: ShellMode): void;
	updateEditorBorderColor: ReturnType<typeof vi.fn>;
};

const prototype = InteractiveMode.prototype as unknown as {
	setShellMode(this: ShellContext, mode: ShellMode): void;
	handleShellInput(this: ShellContext, data: string): boolean;
	setupEditorSubmitHandler(this: SubmitContext): void;
};

function makeShellContext() {
	let text = "";
	const editor = {
		getText: () => text,
		setHistoryScope: vi.fn(),
		setShellMode: vi.fn(),
	};
	const context: ShellContext = {
		shellMode: "normal",
		editor,
		defaultEditor: editor,
		keybindings: new KeybindingsManager(),
		setShellMode: prototype.setShellMode,
		updateEditorBorderColor: vi.fn(),
	};
	return {
		context,
		setText: (value: string) => {
			text = value;
		},
	};
}

type SubmitContext = {
	shellMode: ShellMode;
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: { addToHistory: ReturnType<typeof vi.fn>; setText: ReturnType<typeof vi.fn> };
	session: { isBashRunning: boolean; isCompacting: boolean; isStreaming: boolean };
	handleBashCommand: ReturnType<typeof vi.fn>;
	showWarning: ReturnType<typeof vi.fn>;
	flushPendingBashComponents: ReturnType<typeof vi.fn>;
	pendingUserInputs: string[];
};

describe("interactive Shell mode", () => {
	it("steps through both tiers with empty keyboard input", () => {
		const { context } = makeShellContext();
		expect(prototype.handleShellInput.call(context, "!")).toBe(true);
		expect(context.shellMode).toBe("shell");
		expect(prototype.handleShellInput.call(context, "!")).toBe(true);
		expect(context.shellMode).toBe("shell-no-context");
		expect(prototype.handleShellInput.call(context, "\x7f")).toBe(true);
		expect(context.shellMode).toBe("shell");
		expect(prototype.handleShellInput.call(context, "\x7f")).toBe(true);
		expect(context.shellMode).toBe("normal");
		expect(context.defaultEditor.setHistoryScope).toHaveBeenLastCalledWith("default");
	});

	it("treats nonempty input and bracketed paste as literal text", () => {
		const { context, setText } = makeShellContext();
		setText("draft");
		expect(prototype.handleShellInput.call(context, "!")).toBe(false);
		setText("");
		expect(prototype.handleShellInput.call(context, "\x1b[200~!\x1b[201~")).toBe(false);
		expect(context.shellMode).toBe("normal");
	});

	it("submits commands by active tier and keeps a pasted exclamation mark in normal prompts", async () => {
		const context: SubmitContext = {
			shellMode: "shell",
			defaultEditor: {},
			editor: { addToHistory: vi.fn(), setText: vi.fn() },
			session: { isBashRunning: false, isCompacting: false, isStreaming: false },
			handleBashCommand: vi.fn(async () => {}),
			showWarning: vi.fn(),
			flushPendingBashComponents: vi.fn(),
			pendingUserInputs: [],
		};
		prototype.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("pwd");
		expect(context.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(context.shellMode).toBe("shell");

		context.shellMode = "shell-no-context";
		await context.defaultEditor.onSubmit?.("ls");
		expect(context.handleBashCommand).toHaveBeenCalledWith("ls", true);

		context.shellMode = "normal";
		await context.defaultEditor.onSubmit?.("!literal prompt");
		expect(context.pendingUserInputs).toEqual(["!literal prompt"]);
	});
});
