/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import { Container, getKeybindings, Spacer, Text, type TUI } from "@candy/tui";
import { selectedRowLabel, selectionCursor, selectionMarkerSuffix, theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface ExtensionSelectorOptions {
	tui?: TUI;
	getAvailableHeight?: () => number;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
	description?: string;
	horizontal?: boolean;
}

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;
	private readonly horizontal: boolean;
	private availableHeight = 12;
	private readonly getAvailableHeight: (() => number) | undefined;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		this.baseTitle = title;
		this.horizontal = opts?.horizontal ?? false;
		this.getAvailableHeight = opts?.getAvailableHeight;
		if (this.getAvailableHeight) this.availableHeight = this.getAvailableHeight();

		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		this.addChild(this.titleText);
		if (opts?.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("text", opts.description), 1, 0));
		}
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.updateList();
	}

	override render(width: number): string[] {
		const height = this.getAvailableHeight?.();
		if (height !== undefined && height !== this.availableHeight) this.setAvailableHeight(height);
		return super.render(width);
	}

	setAvailableHeight(height: number): void {
		this.availableHeight = Math.max(5, height);
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.horizontal) {
			this.listContainer.addChild(
				new Text(
					this.options
						.map((option, index) =>
							index === this.selectedIndex
								? `${selectionCursor(true)}${selectedRowLabel(option, true)}${selectionMarkerSuffix(true)}`
								: `${selectionCursor(false)}${theme.fg("muted", `${option}  `)}`,
						)
						.join("   "),
					1,
					0,
				),
			);
			return;
		}
		const maxVisible = Math.max(3, this.availableHeight - 6);
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.options.length - maxVisible),
		);
		for (let i = start; i < Math.min(this.options.length, start + maxVisible); i++) {
			const isSelected = i === this.selectedIndex;
			const text = isSelected
				? `${selectionCursor(true)}${selectedRowLabel(this.options[i], true)}${selectionMarkerSuffix(true)}`
				: `${selectionCursor(false)}${theme.fg("text", this.options[i])}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}
		if (start > 0 || start + maxVisible < this.options.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  ${this.selectedIndex + 1}/${this.options.length}`), 1, 0),
			);
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (
			kb.matches(keyData, "tui.select.up") ||
			(this.horizontal && kb.matches(keyData, "tui.editor.cursorLeft"))
		) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (
			kb.matches(keyData, "tui.select.down") ||
			(this.horizontal && kb.matches(keyData, "tui.editor.cursorRight"))
		) {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
