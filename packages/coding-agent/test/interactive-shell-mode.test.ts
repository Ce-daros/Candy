import { describe, expect, it, vi } from "vitest";
import type { QueuedInput } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { KeybindingsManager } from "../src/presentation/keybindings.ts";

type InputMode = "normal" | "shell" | "shell-no-context" | "command";

type ShellContext = {
	inputMode: InputMode;
	editor: { getText(): string };
	defaultEditor: {
		getText(): string;
		setHistoryScope: ReturnType<typeof vi.fn>;
		setInputMode: ReturnType<typeof vi.fn>;
	};
	keybindings: KeybindingsManager;
	setInputMode(mode: InputMode): void;
	openPresentation: ReturnType<typeof vi.fn>;
	updateEditorBorderColor: ReturnType<typeof vi.fn>;
};

const prototype = InteractiveMode.prototype as unknown as {
	setInputMode(this: ShellContext, mode: InputMode): void;
	handleModeInput(this: ShellContext, data: string): boolean;
	setupEditorSubmitHandler(this: SubmitContext): void;
};

function makeShellContext() {
	let text = "";
	const editor = {
		getText: () => text,
		setHistoryScope: vi.fn(),
		setInputMode: vi.fn(),
	};
	const context: ShellContext = {
		inputMode: "normal",
		editor,
		defaultEditor: editor,
		keybindings: new KeybindingsManager(),
		setInputMode: prototype.setInputMode,
		openPresentation: vi.fn(),
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
	inputMode: InputMode;
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: { addToHistory: ReturnType<typeof vi.fn>; setText: ReturnType<typeof vi.fn> };
	session: { model: { id: string }; isBashRunning: boolean; isCompacting: boolean; isStreaming: boolean };
	createEditorInput(text: string): QueuedInput;
	handleBashCommand: ReturnType<typeof vi.fn>;
	showWarning: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	flushPendingBashComponents: ReturnType<typeof vi.fn>;
	pendingUserInputs: QueuedInput[];
};

describe("interactive Shell mode", () => {
	it("steps through both tiers with empty keyboard input", () => {
		const { context } = makeShellContext();
		expect(prototype.handleModeInput.call(context, "!")).toBe(true);
		expect(context.inputMode).toBe("shell");
		expect(prototype.handleModeInput.call(context, "!")).toBe(true);
		expect(context.inputMode).toBe("shell-no-context");
		expect(prototype.handleModeInput.call(context, "\x7f")).toBe(true);
		expect(context.inputMode).toBe("shell");
		expect(prototype.handleModeInput.call(context, "\x7f")).toBe(true);
		expect(context.inputMode).toBe("normal");
		expect(context.defaultEditor.setHistoryScope).toHaveBeenLastCalledWith("default");
	});

	it("treats nonempty input and bracketed paste as literal text", () => {
		const { context, setText } = makeShellContext();
		setText("draft");
		expect(prototype.handleModeInput.call(context, "!")).toBe(false);
		setText("");
		expect(prototype.handleModeInput.call(context, "\x1b[200~!\x1b[201~")).toBe(false);
		expect(context.inputMode).toBe("normal");
	});

	it("enters Command only from an empty editor on a single slash key", () => {
		const { context, setText } = makeShellContext();
		expect(prototype.handleModeInput.call(context, "/")).toBe(true);
		expect(context.openPresentation).toHaveBeenCalledWith("command");
		context.openPresentation.mockClear();
		setText("draft");
		expect(prototype.handleModeInput.call(context, "/")).toBe(false);
		setText("");
		expect(prototype.handleModeInput.call(context, "\x1b[200~/\x1b[201~")).toBe(false);
		expect(context.openPresentation).not.toHaveBeenCalled();
	});

	it("submits commands by active tier and keeps a pasted exclamation mark in normal prompts", async () => {
		const context: SubmitContext = {
			inputMode: "shell",
			defaultEditor: {},
			editor: { addToHistory: vi.fn(), setText: vi.fn() },
			session: { model: { id: "faux" }, isBashRunning: false, isCompacting: false, isStreaming: false },
			createEditorInput: (text) => ({ text }),
			handleBashCommand: vi.fn(async () => {}),
			showWarning: vi.fn(),
			showError: vi.fn(),
			flushPendingBashComponents: vi.fn(),
			pendingUserInputs: [],
		};
		prototype.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("pwd");
		expect(context.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(context.inputMode).toBe("shell");

		context.inputMode = "shell-no-context";
		await context.defaultEditor.onSubmit?.("ls");
		expect(context.handleBashCommand).toHaveBeenCalledWith("ls", true);

		context.inputMode = "normal";
		await context.defaultEditor.onSubmit?.("!literal prompt");
		await context.defaultEditor.onSubmit?.("/literal prompt");
		expect(context.pendingUserInputs).toEqual([{ text: "!literal prompt" }, { text: "/literal prompt" }]);
	});
});
