import type { Component, Terminal, TUI } from "@candy/tui";
import { Container, getKeybindings, isViewportTUI, ScrollView, setKeybindings, Text } from "@candy/tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { FullscreenExitOutput } from "../src/core/settings-manager.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	RetryStatusIndicator,
	type StatusIndicator,
	type StatusIndicatorKind,
	WorkingStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const EXIT_ALT_SCREEN = "\x1b[?1049l";

const clipboardMocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn<(text: string) => Promise<void>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => clipboardMocks);

class RecordingTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];
	startCount = 0;
	stopCount = 0;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		super.start(onInput, onResize);
	}

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override stop(): void {
		this.stopCount += 1;
		super.stop();
	}
}

describe("createInteractiveTui", () => {
	it("always uses the alternate-screen fullscreen renderer", async () => {
		const terminal = new RecordingTerminal();
		const tui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		expect(tui.mode).toBe("fullscreen");
		expect(isViewportTUI(tui)).toBe(true);
		tui.start();
		await terminal.waitForRender();
		expect(terminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(true);
		tui.stop();
	});

	it("shows the configured jump-to-bottom shortcut while scrolled up", async () => {
		initTheme("dark");
		const previousKeybindings = getKeybindings();
		setKeybindings(new KeybindingsManager({ "tui.altScreen.bottom": "ctrl+j" }));
		const terminal = new RecordingTerminal(50, 4);
		const ui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		ui.setLayoutRoot(
			new ScrollView(new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0), {
				follow: "end",
				primary: true,
			}),
		);
		ui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<64;1;1M");
			await terminal.waitForRender();
			expect(terminal.getViewport()[3]).toContain("↓ Jump to latest message · Ctrl+J");
		} finally {
			ui.stop();
			setKeybindings(previousKeybindings);
		}
	});

	it("prints the transcript document on exit for transcript output", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const renderer = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const component: Component = { render: () => ["transcript line"], invalidate: () => {} };
		renderer.addChild(component);
		const layoutRoot: Component = { render: () => ["viewport line"], invalidate: () => {} };
		renderer.setLayoutRoot(layoutRoot);

		type StopContext = { renderer: ReturnType<typeof createInteractiveTui>; ui: TUI };
		const context = { renderer, ui: renderer } as unknown as StopContext;
		const { stopInteractiveTui } = InteractiveMode.prototype as unknown as {
			stopInteractiveTui(this: StopContext, fullscreenExitOutput: FullscreenExitOutput): void;
		};

		renderer.start();
		await terminal.waitForRender();
		const writesBeforeStop = terminal.writes.length;
		stopInteractiveTui.call(context, "transcript");

		const exitOutput = terminal.writes.slice(writesBeforeStop).join("");
		expect(exitOutput).toContain("transcript line");
		expect(exitOutput).not.toContain("viewport line");
	});

	it("preserves the alt screen on exit for resume-hint output", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const renderer = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const component: Component = { render: () => ["transcript line"], invalidate: () => {} };
		renderer.addChild(component);

		type StopContext = { renderer: ReturnType<typeof createInteractiveTui>; ui: TUI };
		const context = { renderer, ui: renderer } as unknown as StopContext;
		const { stopInteractiveTui } = InteractiveMode.prototype as unknown as {
			stopInteractiveTui(this: StopContext, fullscreenExitOutput: FullscreenExitOutput): void;
		};

		renderer.start();
		await terminal.waitForRender();
		const writesBeforeStop = terminal.writes.length;
		stopInteractiveTui.call(context, "resume-hint");

		const exitOutput = terminal.writes.slice(writesBeforeStop).join("");
		expect(exitOutput).toContain(EXIT_ALT_SCREEN);
		expect(exitOutput).not.toContain("transcript line");
	});
});

describe("InteractiveMode right-click paste", () => {
	it("feeds clipboard text to the focused component as a bracketed paste", async () => {
		clipboardMocks.readClipboardText.mockResolvedValue("clipboard text");
		const handleInput = vi.fn<(data: string) => void>();
		const target = { render: () => [], invalidate: () => {}, handleInput } satisfies Component;
		const requestRender = vi.fn();
		const context = {
			renderer: { getFocusedComponent: () => target },
			ui: { requestRender },
		};
		const prototype = InteractiveMode.prototype as unknown as {
			handleRightClickPaste(this: typeof context): Promise<void>;
		};

		await prototype.handleRightClickPaste.call(context);

		expect(handleInput).toHaveBeenCalledWith("\x1b[200~clipboard text\x1b[201~");
		expect(requestRender).toHaveBeenCalledOnce();
	});
});

type CopyCommandContext = {
	session: { getLastAssistantText: () => string | undefined };
	ui: ReturnType<typeof createInteractiveTui>;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
};

type CopyCommandOptions = { flashConfirmation?: boolean; preferSelection?: boolean };

type CopyCommandPrototype = {
	handleCopyCommand(this: CopyCommandContext, options?: CopyCommandOptions): Promise<void>;
};

const copyCommandPrototype = InteractiveMode.prototype as unknown as CopyCommandPrototype;

describe("InteractiveMode copy confirmation", () => {
	beforeEach(() => {
		clipboardMocks.copyToClipboard.mockReset();
		clipboardMocks.copyToClipboard.mockResolvedValue(undefined);
	});

	it("copies an active fullscreen selection when copy-on-select is disabled", async () => {
		const terminal = new RecordingTerminal(40, 4);
		const ui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
			fullscreenCopyOnSelect: false,
		});
		const getLastAssistantText = vi.fn(() => "assistant response");
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CopyCommandContext = {
			session: { getLastAssistantText },
			ui,
			showStatus,
			showError,
		};
		ui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));

		ui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;4;2M");
			terminal.sendInput("\x1b[<0;4;2m");
			await terminal.waitForRender();
			clipboardMocks.copyToClipboard.mockClear();

			await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true, preferSelection: true });
			await terminal.waitForRender();

			expect(clipboardMocks.copyToClipboard).toHaveBeenCalledOnce();
			expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("alpha\nbeta");
			expect(getLastAssistantText).not.toHaveBeenCalled();
			expect(showStatus).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
			expect(terminal.getViewport().some((line) => line.includes("Copied!"))).toBe(true);
		} finally {
			ui.stop();
		}
	});

	it("copies the last assistant message with an active fullscreen selection when copy-on-select is enabled", async () => {
		const terminal = new RecordingTerminal(40, 4);
		const ui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const getLastAssistantText = vi.fn(() => "assistant response");
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CopyCommandContext = {
			session: { getLastAssistantText },
			ui,
			showStatus,
			showError,
		};
		ui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));

		ui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;4;2M");
			terminal.sendInput("\x1b[<0;4;2m");
			await terminal.waitForRender();
			clipboardMocks.copyToClipboard.mockClear();

			await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true, preferSelection: true });
			await terminal.waitForRender();

			expect(clipboardMocks.copyToClipboard).toHaveBeenCalledOnce();
			expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("assistant response");
			expect(getLastAssistantText).toHaveBeenCalledOnce();
			expect(showStatus).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
			expect(terminal.getViewport().some((line) => line.includes("Copied!"))).toBe(true);
		} finally {
			ui.stop();
		}
	});

	it("flashes Copied! for the copy shortcut in fullscreen mode", async () => {
		const terminal = new RecordingTerminal(40, 4);
		const ui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			ui,
			showStatus,
			showError,
		};

		ui.start();
		try {
			await terminal.waitForRender();
			await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true, preferSelection: true });
			await terminal.waitForRender();

			expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("assistant response");
			expect(showStatus).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
			expect(terminal.getViewport().some((line) => line.includes("Copied!"))).toBe(true);
		} finally {
			ui.stop();
		}
	});
});

type StatusEditor = {
	embedWorkingStatus: boolean;
	setWorkingStatusIndicator: (indicator: StatusIndicator | undefined) => void;
};

type ClearStatusContext = {
	activeStatusIndicator: { kind: StatusIndicatorKind; dispose: () => void } | undefined;
	activeWorkingIndicatorEmbedded: boolean;
	statusContainer: Container;
	defaultEditor: StatusEditor;
	editor: Partial<StatusEditor>;
	setEditorWorkingStatusIndicator(indicator: StatusIndicator | undefined): boolean;
};

type InteractiveModePrototype = {
	showStatusIndicator(this: ClearStatusContext, indicator: StatusIndicator): void;
	clearStatusIndicator(this: ClearStatusContext, kind?: StatusIndicatorKind): void;
	setEditorWorkingStatusIndicator(this: ClearStatusContext, indicator: StatusIndicator | undefined): boolean;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("clear-on-shrink status spacing", () => {
	it.each([true, false])("routes every status through the editor opt-in (%s)", (embedWorkingStatus) => {
		initTheme("dark");
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const editor: StatusEditor = { embedWorkingStatus, setWorkingStatusIndicator: vi.fn() };
		const context: ClearStatusContext = {
			activeStatusIndicator: undefined,
			activeWorkingIndicatorEmbedded: false,
			statusContainer: new Container(),
			defaultEditor: { embedWorkingStatus: true, setWorkingStatusIndicator: vi.fn() },
			editor,
			setEditorWorkingStatusIndicator: interactiveModePrototype.setEditorWorkingStatusIndicator,
		};
		const indicators = [
			new WorkingStatusIndicator(tui, "Working"),
			new CompactionStatusIndicator(tui, "manual"),
			new CompactionStatusIndicator(tui, "threshold"),
			new CompactionStatusIndicator(tui, "overflow"),
			new BranchSummaryStatusIndicator(tui),
			new RetryStatusIndicator(tui, 1, 3, 1000),
		];
		try {
			for (const indicator of indicators) {
				interactiveModePrototype.showStatusIndicator.call(context, indicator);
				expect(context.activeStatusIndicator).toBe(indicator);
				expect(context.activeWorkingIndicatorEmbedded).toBe(embedWorkingStatus);
				if (embedWorkingStatus) {
					expect(editor.setWorkingStatusIndicator).toHaveBeenLastCalledWith(indicator);
					expect(context.statusContainer.children).toHaveLength(0);
				} else {
					expect(context.statusContainer.children).toEqual([indicator]);
				}
			}
		} finally {
			for (const indicator of indicators) indicator.dispose();
		}
	});

	it.each<StatusIndicatorKind>(["working", "compaction", "branchSummary", "retry"])(
		"does not reserve separate status height for an embedded %s indicator",
		(kind) => {
			const dispose = vi.fn();
			const editor: StatusEditor = { embedWorkingStatus: true, setWorkingStatusIndicator: vi.fn() };
			const context: ClearStatusContext = {
				activeStatusIndicator: { kind, dispose },
				activeWorkingIndicatorEmbedded: true,
				statusContainer: new Container(),
				defaultEditor: editor,
				editor,
				setEditorWorkingStatusIndicator: interactiveModePrototype.setEditorWorkingStatusIndicator,
			};

			interactiveModePrototype.clearStatusIndicator.call(context);

			expect(dispose).toHaveBeenCalledOnce();
			expect(editor.setWorkingStatusIndicator).toHaveBeenCalledWith(undefined);
			expect(context.statusContainer.children).toHaveLength(0);
		},
	);

	it("uses the standalone row for a custom editor that has not opted in", () => {
		const defaultEditor: StatusEditor = { embedWorkingStatus: true, setWorkingStatusIndicator: vi.fn() };
		const customEditor = { embedWorkingStatus: false, setWorkingStatusIndicator: vi.fn() };
		const context: ClearStatusContext = {
			activeStatusIndicator: { kind: "working", dispose: vi.fn() },
			activeWorkingIndicatorEmbedded: false,
			statusContainer: new Container(),
			defaultEditor,
			editor: customEditor,
			setEditorWorkingStatusIndicator: interactiveModePrototype.setEditorWorkingStatusIndicator,
		};

		interactiveModePrototype.clearStatusIndicator.call(context);

		expect(defaultEditor.setWorkingStatusIndicator).toHaveBeenCalledWith(undefined);
		expect(customEditor.setWorkingStatusIndicator).not.toHaveBeenCalled();
		expect(context.statusContainer.children).toHaveLength(0);
	});
});
