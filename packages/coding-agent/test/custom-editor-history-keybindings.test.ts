import { setKeybindings, TuiMainScreen } from "@candy/tui";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { KeybindingsManager } from "../src/presentation/keybindings.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("CustomEditor prompt history keybindings", () => {
	it("gives an explicit history binding precedence over application actions", () => {
		const keybindings = new KeybindingsManager({
			"tui.editor.historyPrevious": "ctrl+p",
			"tui.editor.historyNext": "ctrl+n",
			"app.model.select": "ctrl+p",
		});
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let modelSelections = 0;
		editor.onAction("app.model.select", () => {
			modelSelections++;
		});
		editor.addToHistory("previous prompt");
		editor.setText("draft");

		editor.handleInput("\x10"); // Ctrl+P
		expect(editor.getText()).toBe("previous prompt");
		expect(modelSelections).toBe(0);

		editor.handleInput("\x0e"); // Ctrl+N
		expect(editor.getText()).toBe("draft");
	});
});
