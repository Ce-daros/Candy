import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	type Keybinding,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@candy/tui";
import { theme } from "../theme/theme.ts";
import { formatKeyText, keycap, keyHint } from "./keybinding-hints.ts";

/** Component that renders tree help as semantic rows with chunk-aware wrapping */
export class TreeHelp implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		const items = TREE_HELP_ITEMS.map(({ keys, label, labelFirst }) => {
			const text = formatHelpKeys(keys);
			if (!text) return theme.fg("muted", label);
			return labelFirst ? `${theme.fg("muted", label)} ${text}` : `${text} ${theme.fg("muted", label)}`;
		});

		const primary = `${keyHint("app.panel.focusNext", "panels")} · ${keyHint("tui.select.confirm", "navigate")} · ${keyHint("tui.select.cancel", "close")} · ${items.slice(0, 5).join(" · ")}`;
		const secondary = items.slice(5).join(" · ");
		return [...wrapTextWithAnsi(primary, Math.max(1, width)), ...wrapTextWithAnsi(secondary, Math.max(1, width))];
	}
}

const TREE_HELP_ITEMS: Array<{ keys: Keybinding[]; label: string; labelFirst?: boolean }> = [
	{ keys: ["tui.select.up", "tui.select.down"], label: "move" },
	{ keys: ["tui.editor.cursorLeft", "tui.editor.cursorRight"], label: "page" },
	{ keys: ["app.tree.foldOrUp", "app.tree.unfoldOrDown"], label: "branch" },
	{ keys: ["app.message.copy"], label: "copy" },
	{ keys: ["app.tree.editLabel"], label: "label" },
	{ keys: ["app.tree.toggleLabelTimestamp"], label: "label time" },
	{
		keys: [
			"app.tree.filter.default",
			"app.tree.filter.noTools",
			"app.tree.filter.userOnly",
			"app.tree.filter.labeledOnly",
			"app.tree.filter.all",
		],
		label: "filters",
		labelFirst: true,
	},
	{ keys: ["app.tree.filter.cycleForward", "app.tree.filter.cycleBackward"], label: "cycle", labelFirst: true },
];

function formatHelpKeys(keybindings: Keybinding[]): string {
	const keys: string[] = [];
	for (const keybinding of keybindings) {
		const key = getKeybindings().getKeys(keybinding)[0];
		if (key !== undefined) keys.push(key);
	}
	if (keys.length === 0) return "";

	return keycap(
		formatKeyText(compactRawKeys(keys))
			.replace(/\bpageUp\b/g, "pgup")
			.replace(/\bpageDown\b/g, "pgdn")
			.replace(/\bup\b/g, "↑")
			.replace(/\bdown\b/g, "↓")
			.replace(/\bleft\b/g, "←")
			.replace(/\bright\b/g, "→"),
	);
}

function compactRawKeys(keys: string[]): string {
	if (keys.length === 1) return keys[0]!;

	const parts = keys.map((key) => {
		const separatorIndex = key.lastIndexOf("+");
		return separatorIndex === -1
			? { prefix: "", suffix: key }
			: { prefix: key.slice(0, separatorIndex + 1), suffix: key.slice(separatorIndex + 1) };
	});
	const prefix = parts[0]!.prefix;
	return prefix && parts.every((part) => part.prefix === prefix)
		? `${prefix}${parts.map((part) => part.suffix).join("/")}`
		: keys.join("/");
}

/** Label input component shown when editing a label */
export class LabelInput implements Component, Focusable {
	private input: Input;
	private entryId: string;
	public onSubmit?: (entryId: string, label: string | undefined) => void;
	public onCancel?: () => void;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(entryId: string, currentLabel: string | undefined) {
		this.entryId = entryId;
		this.input = new Input();
		if (currentLabel) {
			this.input.setValue(currentLabel);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const indent = "  ";
		const availableWidth = width - indent.length;
		lines.push(truncateToWidth(`${indent}${theme.fg("muted", "Label (empty to remove):")}`, width));
		lines.push(...this.input.render(availableWidth).map((line) => truncateToWidth(`${indent}${line}`, width)));
		lines.push(
			truncateToWidth(
				`${indent}${keyHint("tui.select.confirm", "save")}  ${keyHint("tui.select.cancel", "cancel")}`,
				width,
			),
		);
		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm")) {
			const value = this.input.getValue().trim();
			this.onSubmit?.(this.entryId, value || undefined);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel?.();
		} else {
			this.input.handleInput(keyData);
		}
	}
}
