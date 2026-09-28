import {
	type Focusable,
	getKeybindings,
	Input,
	Markdown,
	moveSelection,
	moveViewport,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@candy/tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

export interface ReadingPanelRow {
	category: string;
	label: string;
	value: string;
}

export class ReadingPanelComponent implements Focusable {
	private readonly title: string;
	private readonly onClose: () => void;
	private readonly onEdit?: () => void;
	private readonly markdown: Markdown;
	private readonly searchInput = new Input({ placeholder: "Search" });
	private rows?: readonly ReadingPanelRow[];
	private filteredRows: readonly ReadingPanelRow[] = [];
	private availableHeight = 20;
	private offset = 0;
	private selectedIndex = 0;
	private region: "reading" | "search" | "edit" | "close" = "reading";
	private _focused = false;
	private visibleRows = 0;
	private markdownLineCount = 0;
	private firstBodyRow = 2;
	private lastSearchRow = -1;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.region === "search";
	}

	constructor(
		title: string,
		content: string,
		onClose: () => void,
		rows?: readonly ReadingPanelRow[],
		onEdit?: () => void,
	) {
		this.title = title;
		this.onClose = onClose;
		this.onEdit = onEdit;
		this.markdown = new Markdown(content, 0, 0, getMarkdownTheme(), undefined, {
			onCopyCode: (code) => void copyToClipboard(code),
		});
		this.setRows(rows);
	}

	setAvailableHeight(height: number): void {
		this.availableHeight = Math.max(6, height);
	}

	setContent(content: string): void {
		this.markdown.setText(content);
		this.offset = 0;
	}

	setRows(rows?: readonly ReadingPanelRow[]): void {
		this.rows = rows;
		this.filterRows();
	}

	private filterRows(): void {
		if (!this.rows) return;
		const query = this.searchInput.getValue().trim().toLocaleLowerCase();
		this.filteredRows = query
			? this.rows.filter((row) =>
					`${row.category} ${row.label} ${stripAnsi(row.value)}`.toLocaleLowerCase().includes(query),
				)
			: this.rows;
		this.selectedIndex = 0;
		this.offset = 0;
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		const lines = [theme.bold(theme.fg("accent", this.title)), ""];
		this.firstBodyRow = lines.length;
		const footer = this.rows
			? `${this.filteredRows.length} actions · ${keyHint("app.panel.focusNext", "search")} · ${keyHint("tui.select.cancel", "close")}`
			: `${keyHint("tui.select.up", "up")} ${keyHint("tui.select.down", "down")} scroll · ${this.onEdit ? `${keyHint("app.panel.focusNext", this.region === "edit" ? "close" : this.region === "close" ? "read" : "Edit")} ${this.region === "edit" ? keyHint("tui.select.confirm", "edit") : this.region === "close" ? keyHint("tui.select.confirm", "close") : ""} · ` : ""}${keyHint("tui.select.cancel", "close")}`;
		const footerLines = new Text(theme.fg("muted", footer), 0, 0).render(width);
		const footerBudget = this.rows
			? footerLines.length
			: Math.max(footerLines.length, new Text(`99999–99999 / 99999 · ${footer}`, 0, 0).render(width).length);
		this.visibleRows = Math.max(1, this.availableHeight - (this.rows ? 5 : 4) - footerBudget);
		if (this.rows) {
			const body: string[] = [];
			let previousCategory = "";
			for (let index = 0; index < this.filteredRows.length; index++) {
				const row = this.filteredRows[index];
				const keyWidth = Math.min(visibleWidth(row.value), Math.max(1, width - 24));
				if (row.category !== previousCategory) {
					body.push(theme.fg("muted", row.category));
					previousCategory = row.category;
				}
				const selected = index === this.selectedIndex;
				const label = truncateToWidth(row.label, Math.max(1, width - keyWidth - 7));
				const value = truncateToWidth(row.value, keyWidth);
				const name = selected ? theme.bold(theme.fg("accent", label)) : label;
				const prefix = selected ? theme.fg("borderAccent", "♦ ") : "  ";
				const suffix = selected ? theme.fg("borderAccent", " ♦") : "";
				const spacing = " ".repeat(
					Math.max(
						1,
						width - visibleWidth(prefix) - visibleWidth(name) - visibleWidth(value) - visibleWidth(suffix),
					),
				);
				body.push(`${prefix}${name}${spacing}${value}${suffix}`);
			}
			if (body.length === 0) body.push(theme.fg("muted", "No matching actions"));
			const selectedRow = this.filteredRows[this.selectedIndex];
			let selectedBodyIndex = 0;
			if (selectedRow) {
				let category = "";
				for (let index = 0; index <= this.selectedIndex; index++) {
					const row = this.filteredRows[index];
					if (row.category !== category) {
						selectedBodyIndex++;
						category = row.category;
					}
					selectedBodyIndex++;
				}
				selectedBodyIndex--;
			}
			this.offset = moveViewport(this.offset, body.length, this.visibleRows, 0);
			if (selectedBodyIndex < this.offset) this.offset = selectedBodyIndex;
			if (selectedBodyIndex >= this.offset + this.visibleRows)
				this.offset = selectedBodyIndex - this.visibleRows + 1;
			lines.push(...body.slice(this.offset, this.offset + this.visibleRows));
			lines.push(theme.fg("borderMuted", "─".repeat(width)));
			this.lastSearchRow = lines.length;
			lines.push(...this.searchInput.render(width));
			lines.push(...footerLines);
		} else {
			const body = this.markdown.render(width);
			this.markdownLineCount = body.length;
			this.offset = moveViewport(this.offset, body.length, this.visibleRows, 0);
			lines.push(...body.slice(this.offset, this.offset + this.visibleRows));
			lines.push(theme.fg("borderMuted", "─".repeat(width)));
			lines.push(
				...new Text(
					`${theme.fg(
						"muted",
						`${Math.min(this.offset + 1, body.length)}–${Math.min(this.offset + this.visibleRows, body.length)} / ${body.length}`,
					)} · ${footer}`,
					0,
					0,
				).render(width),
			);
		}
		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onClose();
			return;
		}
		if (kb.matches(data, "app.panel.focusNext") || kb.matches(data, "app.panel.focusPrevious") || data === "\t") {
			if (this.onEdit)
				this.region = this.region === "reading" ? "edit" : this.region === "edit" ? "close" : "reading";
			else if (this.rows) this.region = this.region === "reading" ? "search" : "reading";
			this.searchInput.focused = this._focused && this.region === "search";
			return;
		}
		if (kb.matches(data, "tui.select.confirm") && this.region === "edit" && this.onEdit) {
			this.onEdit();
			return;
		}
		if (kb.matches(data, "tui.select.confirm") && this.region === "close") {
			this.onClose();
			return;
		}
		if (
			kb.matches(data, "tui.select.up") ||
			kb.matches(data, "tui.select.down") ||
			kb.matches(data, "tui.select.pageUp") ||
			kb.matches(data, "tui.select.pageDown")
		) {
			const delta = kb.matches(data, "tui.select.up")
				? -1
				: kb.matches(data, "tui.select.down")
					? 1
					: kb.matches(data, "tui.select.pageUp")
						? -this.visibleRows
						: this.visibleRows;
			if (this.rows) this.selectedIndex = moveSelection(this.selectedIndex, this.filteredRows.length, delta);
			else this.offset = moveViewport(this.offset, this.markdownLineCount, this.visibleRows, delta);
			return;
		}
		if (this.rows && this.region !== "edit" && this.region !== "close") {
			this.region = "search";
			this.searchInput.focused = this._focused;
			this.searchInput.handleInput(data);
			this.filterRows();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			if (this.rows)
				this.selectedIndex = moveSelection(
					this.selectedIndex,
					this.filteredRows.length,
					event.wheelDelta < 0 ? 1 : -1,
				);
			else
				this.offset = moveViewport(
					this.offset,
					this.markdownLineCount,
					this.visibleRows,
					event.wheelDelta < 0 ? 3 : -3,
				);
			return { handled: true, render: true };
		}
		if (this.rows && event.type === "click" && event.button === "left" && event.y === this.lastSearchRow) {
			this.region = "search";
			this.searchInput.focused = this._focused;
			return this.searchInput.handleMouse?.({ ...event, y: 0 });
		}
		if (!this.rows && event.y >= this.firstBodyRow && event.y < this.firstBodyRow + this.visibleRows) {
			return this.markdown.handleMouse?.({ ...event, y: event.y - this.firstBodyRow + this.offset });
		}
		return undefined;
	}
}
