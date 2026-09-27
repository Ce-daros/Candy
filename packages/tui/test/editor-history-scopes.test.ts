import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("Editor history scopes", () => {
	it("keeps prompt, Shell, and no-context command history separate", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.addToHistory("normal prompt");
		editor.setHistoryScope("shell");
		editor.addToHistory("pwd");
		editor.setHistoryScope("shell-no-context");
		editor.addToHistory("secret command");

		editor.handleInput("\x1b[A");
		assert.equal(editor.getText(), "secret command");
		editor.setText("");

		editor.setHistoryScope("shell");
		editor.handleInput("\x1b[A");
		assert.equal(editor.getText(), "pwd");
		editor.setText("");

		editor.setHistoryScope("default");
		editor.handleInput("\x1b[A");
		assert.equal(editor.getText(), "normal prompt");
	});

	it("ends history browsing when the active scope changes", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.addToHistory("old prompt");
		editor.handleInput("\x1b[A");
		editor.setHistoryScope("shell");
		editor.addToHistory("ls");
		editor.setText("");
		editor.handleInput("\x1b[A");
		assert.equal(editor.getText(), "ls");
	});
});
