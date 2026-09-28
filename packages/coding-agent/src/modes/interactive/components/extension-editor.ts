/**
 * Multi-line editor component for extensions.
 * Supports Ctrl+G for external editor.
 */

import {
	Container,
	Editor,
	type EditorOptions,
	type Focusable,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
} from "@candy/tui";
import type { KeybindingsManager } from "../../../presentation/keybindings.ts";
import { editInExternalEditor } from "../external-editor.ts";
import { getEditorTheme, theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

export interface ExtensionEditorOptions extends EditorOptions {
	description?: string;
}

class PanelEditor extends Editor {
	protected override renderTopBorder(_width: number, _hiddenLineCount: number): string {
		return "";
	}

	protected override renderBottomBorder(_width: number, _hiddenLineCount: number): string {
		return "";
	}
}

export class ExtensionEditorComponent extends Container implements Focusable {
	private editor: Editor;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private keybindings: KeybindingsManager;
	private externalEditorCommand: string;
	private availableHeight = 20;
	private readonly hasDescription: boolean;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		tui: TUI,
		keybindings: KeybindingsManager,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: ExtensionEditorOptions,
		externalEditorCommand?: string,
	) {
		super();

		this.tui = tui;
		this.keybindings = keybindings;
		this.externalEditorCommand =
			externalEditorCommand ||
			process.env.VISUAL ||
			process.env.EDITOR ||
			(process.platform === "win32" ? "notepad" : "nano");
		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;
		const { description, ...editorOptions } = options ?? {};
		this.hasDescription = Boolean(description);

		// Add title and optional description
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("text", description), 1, 0));
		}
		this.addChild(new Spacer(1));

		// Create editor
		this.editor = new PanelEditor(tui, getEditorTheme(), editorOptions);
		if (prefill) {
			this.editor.setText(prefill);
		}
		// Wire up Enter to submit (Shift+Enter for newlines, like the main editor)
		this.editor.onSubmit = (text: string) => {
			this.onSubmitCallback(text);
		};
		this.addChild(this.editor);

		this.addChild(new Spacer(1));

		// Add hint
		const hint =
			keyHint("tui.select.confirm", "submit") +
			"  " +
			keyHint("tui.input.newLine", "newline") +
			"  " +
			keyHint("tui.select.cancel", "cancel") +
			`  ${keyHint("app.editor.external", "external editor")}`;
		this.addChild(new Text(hint, 1, 0));
	}

	setAvailableHeight(height: number): void {
		this.availableHeight = Math.max(8, height);
	}

	override render(width: number): string[] {
		this.editor.setViewportLines(Math.max(3, this.availableHeight - (this.hasDescription ? 8 : 6)));
		return super.render(width);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Escape or Ctrl+C to cancel
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}

		// External editor (app keybinding)
		if (this.keybindings.matches(keyData, "app.editor.external")) {
			void this.handleOpenExternalEditor();
			return;
		}

		// Forward to editor
		this.editor.handleInput(keyData);
	}

	private async handleOpenExternalEditor(): Promise<void> {
		const content = this.editor.getText();
		this.tui.stop();
		try {
			const result = await editInExternalEditor({
				command: this.externalEditorCommand,
				content,
			});
			if (result.status === "complete") {
				this.editor.setText(result.content);
			}
		} finally {
			this.tui.start();
			this.tui.requestRender(true);
		}
	}
}
