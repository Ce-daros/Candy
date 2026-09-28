import type { ImageContent } from "@candy/ai";
import { describe, expect, it, vi } from "vitest";
import type { QueuedInput } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	inputMode: string;
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		model?: object;
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	createEditorInput: (
		text: string,
		imagePaths?: string[],
		promptText?: string,
	) => { text: string; images?: ImageContent[] };
	showError: (message: string, title?: string) => void;
	onInputCallback?: (input: QueuedInput) => void;
	pendingUserInputs: QueuedInput[];
};

type InputContext = {
	onInputCallback?: (input: QueuedInput) => void;
	pendingUserInputs: QueuedInput[];
};

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	createEditorInput: (
		text: string,
		imagePaths?: string[],
		promptText?: string,
	) => { text: string; images?: ImageContent[] };
	restoreImagesToEditor: (images: ImageContent[]) => void;
	showStatus: (message: string) => void;
};

type InteractiveModePrivate = {
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		inputMode: "normal",
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			model: {},
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		createEditorInput: (text) => ({ text }),
		showError: vi.fn(),
		pendingUserInputs: [],
	};
}

describe("InteractiveMode startup input", () => {
	it("restores a prompt submitted while managed-tool setup is running", () => {
		const context: StartupSubmitContext = {
			editor: { setText: vi.fn() },
			createEditorInput: (text) => ({ text }),
			restoreImagesToEditor: vi.fn(),
			showStatus: vi.fn(),
		};

		interactiveModePrototype.handleStartupSubmit.call(context, "early prompt");

		expect(context.editor.setText).toHaveBeenCalledWith("early prompt");
		expect(context.showStatus).toHaveBeenCalledWith("Startup is still in progress");
	});

	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual([{ text: "early prompt" }]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const queuedInput: QueuedInput = { text: "queued prompt" };
		const context: InputContext = {
			pendingUserInputs: [queuedInput],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe(queuedInput);
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});
});
