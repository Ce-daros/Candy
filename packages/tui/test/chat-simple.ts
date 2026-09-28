/**
 * Simple chat interface demo using tui.ts
 */

import chalk from "chalk";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { Loader } from "../src/components/loader.ts";
import { Markdown } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { ProcessTerminal } from "../src/terminal.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme, defaultMarkdownTheme } from "./test-themes.ts";

// Create terminal
const terminal = new ProcessTerminal();

// Create TUI
const tui: TUI = new TuiMainScreen(terminal);

// Create chat container with some initial messages
tui.addChild(new Text("Welcome to Simple Chat!\n\nType your messages below. Press Ctrl+C to exit."));

// Create editor with autocomplete
const editor = new Editor(tui, defaultEditorTheme);

const autocompleteProvider = new CombinedAutocompleteProvider(process.cwd());
editor.setAutocompleteProvider(autocompleteProvider);

tui.addChild(editor);

// Focus the editor
tui.setFocus(editor);

// Track if we're waiting for bot response
let isResponding = false;

// Handle message submission
editor.onSubmit = (value: string) => {
	// Prevent submission if already responding
	if (isResponding) {
		return;
	}

	const trimmed = value.trim();

	if (trimmed) {
		isResponding = true;
		editor.disableSubmit = true;

		const userMessage = new Markdown(value, 1, 1, defaultMarkdownTheme);

		const children = tui.children;
		children.splice(children.length - 1, 0, userMessage);

		const loader = new Loader(
			tui,
			(s) => chalk.cyan(s),
			(s) => chalk.dim(s),
			"Thinking...",
		);
		children.splice(children.length - 1, 0, loader);

		tui.requestRender();

		setTimeout(() => {
			tui.removeChild(loader);

			// Simulate a response
			const responses = [
				"That's interesting! Tell me more.",
				"I see what you mean.",
				"Fascinating perspective!",
				"Could you elaborate on that?",
				"That makes sense to me.",
				"I hadn't thought of it that way.",
				"Great point!",
				"Thanks for sharing that.",
			];
			const randomResponse = responses[Math.floor(Math.random() * responses.length)];

			// Add assistant message with no background (transparent)
			const botMessage = new Markdown(randomResponse, 1, 1, defaultMarkdownTheme);
			children.splice(children.length - 1, 0, botMessage);

			// Re-enable submit
			isResponding = false;
			editor.disableSubmit = false;

			// Request render
			tui.requestRender();
		}, 1000);
	}
};

// Start the TUI
tui.start();
