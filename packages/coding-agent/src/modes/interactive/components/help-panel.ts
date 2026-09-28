import {
	type Component,
	fuzzyFilter,
	type SelectItem,
	SelectList,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@candy/tui";
import type { AnimationIntensity } from "../../../core/settings-manager.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";
import { PanelTransition, panelPhase } from "./panel-transition.ts";

const HELP_ITEMS: SelectItem[] = [
	{ value: "hotkeys", label: "Hotkeys" },
	{ value: "changelog", label: "Changelog" },
];

export class HelpPanel implements Component {
	private readonly transition: PanelTransition;
	private readonly ui: TUI;
	private readonly onSelect: (id: string) => void;
	private readonly getQuery: () => string;
	private list = new SelectList(HELP_ITEMS, 2, getSelectListTheme());
	private query = "";
	private queryActive = true;
	private listStartRow = 0;
	private visibleRows = 0;

	constructor(ui: TUI, getQuery: () => string, onSelect: (id: string) => void) {
		this.ui = ui;
		this.getQuery = getQuery;
		this.onSelect = onSelect;
		this.transition = new PanelTransition(() => ui.requestRender());
		this.list.onSelect = (item) => this.onSelect(item.value);
	}

	setOptions(enabled: boolean, intensity: AnimationIntensity): void {
		this.transition.setOptions(enabled, intensity);
	}

	open(): void {
		this.queryActive = true;
		this.transition.setOpen(true);
	}

	close(onComplete: () => void): void {
		this.queryActive = false;
		this.transition.setOpen(false, onComplete);
	}

	dispose(): void {
		this.transition.dispose();
	}

	invalidate(): void {
		this.list.invalidate();
	}

	setQuery(query: string): void {
		if (this.query === query) return;
		this.query = query;
		this.list = new SelectList(
			query ? fuzzyFilter(HELP_ITEMS, query, (item) => item.label) : HELP_ITEMS,
			2,
			getSelectListTheme(),
		);
		this.list.onSelect = (item) => this.onSelect(item.value);
		this.ui.requestRender();
	}

	move(key: string): void {
		this.setQuery(this.getQuery());
		this.list.handleInput(key);
		this.ui.requestRender();
	}

	select(): void {
		this.setQuery(this.getQuery());
		const selected = this.list.getSelectedItem();
		if (selected) this.onSelect(selected.value);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.transition.value() < 1 || event.y < this.listStartRow || event.y >= this.listStartRow + this.visibleRows)
			return undefined;
		const result = this.list.handleMouse({
			...event,
			x: event.x - 2,
			y: event.y - this.listStartRow,
			width: event.width - 4,
			height: this.visibleRows,
		});
		return result ? { ...result, focus: false } : undefined;
	}

	render(width: number): string[] {
		if (this.queryActive) this.setQuery(this.getQuery());
		const innerWidth = Math.max(1, width - 4);
		const border = (text: string) => theme.fg("borderAccent", text);
		const row = (content: string) => {
			const text = truncateToWidth(content, innerWidth, "");
			return `${border("│ ")}${text}${" ".repeat(Math.max(0, innerWidth - visibleWidth(text)))}${border(" │")}`;
		};
		const listLines = this.list.render(innerWidth);
		const lines = [
			border(`╭${"─".repeat(Math.max(0, width - 2))}╮`),
			row(theme.bold(theme.fg("borderAccent", "Help"))),
			...listLines.map(row),
			row(
				`${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "open")}  ${keyHint("tui.select.cancel", "close")}`,
			),
			border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
		];
		const { growth } = panelPhase(this.transition.value());
		const visible = Math.ceil(lines.length * growth);
		this.visibleRows = listLines.length;
		this.listStartRow = 2;
		return visible === 0 ? [] : lines.slice(-visible);
	}
}
