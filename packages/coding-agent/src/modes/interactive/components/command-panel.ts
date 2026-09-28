import {
	type AutocompleteItem,
	type Component,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@candy/tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface CommandPanelAction {
	id: string;
	name: string;
	description?: string;
	source?: string;
	searchText?: string;
	checked?: boolean;
	argumentHint?: string;
	initialArgs?: string;
	argumentMode: "none" | "optional" | "single" | "multiple";
	getArgumentCompletions?(
		prefix: string,
		signal: AbortSignal,
		force?: boolean,
	): AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	execute(args: string): Promise<"stay" | "message" | "edit" | undefined> | Promise<void>;
}

export interface CommandPanelOptions {
	title?: string;
	description?: string;
	onCancel: () => void;
	onMessage: () => void;
	requestRender: () => void;
	onSelectionChange?: (ids: string[], checked: boolean) => void;
}

export class CommandPanel implements Component, Focusable {
	private actions: readonly CommandPanelAction[];
	private readonly options: CommandPanelOptions;
	private readonly searchInput: Input;
	private readonly argumentInput = new Input({ prompt: "> " });
	private list: SelectList;
	private completions: SelectList | undefined;
	private activeAction: CommandPanelAction | undefined;
	private description: string;
	private availableHeight = 20;
	private completionVersion = 0;
	private completionController: AbortController | undefined;
	private executionVersion = 0;
	private disposed = false;
	private suspended = false;
	private pending = false;
	private error: string | undefined;
	private focusedValue = false;
	private listStartRow = 0;
	private searchStartRow = 0;
	private completionStartRow = 0;
	private searchFocused = false;
	private messagePending = false;

	constructor(actions: readonly CommandPanelAction[], options: CommandPanelOptions) {
		this.actions = actions;
		this.options = options;
		this.searchInput = new Input({
			prompt:
				options.title === undefined || options.title === "Command"
					? "/ "
					: options.title === "Help"
						? "? "
						: "Search: ",
		});
		this.description = options.description ?? "";
		this.list = this.buildList(actions);
	}

	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		this.focusedValue = value;
		this.searchInput.focused = value && !this.activeAction && (!this.options.onSelectionChange || this.searchFocused);
		this.argumentInput.focused = value && !!this.activeAction;
	}

	getSelectedId(): string | undefined {
		return this.activeAction?.id ?? this.list.getSelectedItem()?.value;
	}

	getQuery(): string {
		return this.searchInput.getValue();
	}

	setActions(actions: readonly CommandPanelAction[]): void {
		const selectedId = this.getSelectedId();
		this.actions = actions;
		this.activeAction = this.activeAction && actions.find((action) => action.id === this.activeAction?.id);
		this.updateList(selectedId);
		this.options.requestRender();
	}

	setDescription(description: string): void {
		this.description = description;
		this.options.requestRender();
	}

	setAvailableHeight(height: number): void {
		this.availableHeight = Math.max(4, height);
	}

	suspend(): void {
		this.suspended = true;
		this.completionVersion += 1;
		this.completionController?.abort();
	}

	resume(): void {
		this.suspended = false;
		if (this.messagePending) {
			const version = this.executionVersion;
			queueMicrotask(() => {
				if (!this.disposed && !this.suspended && version === this.executionVersion) {
					this.messagePending = false;
					this.options.onMessage();
				}
			});
		}
		this.options.requestRender();
	}

	dispose(): void {
		this.disposed = true;
		this.completionController?.abort();
		this.completionVersion += 1;
		this.executionVersion += 1;
	}

	invalidate(): void {
		this.list.invalidate();
		this.completions?.invalidate();
	}

	render(width: number): string[] {
		const title = this.activeAction
			? `${this.options.title ?? "Command"} · ${this.activeAction.name}`
			: (this.options.title ?? "Command");
		const lines = new Text(theme.bold(theme.fg("accent", title)), 0, 0).render(width);
		if (this.description) {
			const descriptionLines = new Text(theme.fg("muted", this.description), 0, 0).render(width);
			lines.push(...descriptionLines.slice(0, Math.max(0, this.availableHeight - 5)));
		}
		lines.push("");
		if (this.activeAction) {
			if (this.activeAction.argumentHint)
				lines.push(...new Text(theme.fg("muted", this.activeAction.argumentHint), 0, 0).render(width));
			lines.push(...this.argumentInput.render(width));
			if (this.error) lines.push(...new Text(theme.fg("error", this.error), 0, 0).render(width));
			this.completionStartRow = lines.length;
			if (this.completions) {
				this.completions.setMaxVisible(Math.max(1, this.availableHeight - lines.length - 2));
				lines.push(...this.completions.render(width));
			}
			lines.push("");
			lines.push(`${keyHint("tui.select.confirm", "run")}  ${keyHint("tui.select.cancel", "back")}`);
		} else {
			this.searchStartRow = lines.length;
			lines.push(...this.searchInput.render(width));
			lines.push("");
			this.listStartRow = lines.length;
			const errorLines = this.error ? new Text(theme.fg("error", this.error), 0, 0).render(width) : [];
			const selectionHints = this.options.onSelectionChange
				? new Text(
						`${keyHint("app.models.toggle", "toggle")}  ${keyHint("app.models.selectAll", "select matching")}  ${keyHint("app.models.clearSelection", "clear matching")}`,
						0,
						0,
					).render(width)
				: [];
			this.list.setMaxVisible(
				Math.max(1, this.availableHeight - lines.length - 3 - selectionHints.length - errorLines.length),
			);
			lines.push(...this.list.render(width));
			lines.push(...errorLines);
			lines.push("");
			lines.push(...selectionHints);
			const selected = this.actions.find((action) => action.id === this.getSelectedId());
			lines.push(
				`${rawKeyHint("↑↓", "navigate")}  ${this.options.onSelectionChange ? `${keyHint("app.panel.focusNext", this.searchFocused ? "list" : "search")}  ` : ""}${keyHint("tui.select.confirm", "select")}  ${selected?.argumentMode === "optional" ? `${keyHint("app.command.arguments", "arguments")}  ` : ""}${keyHint("tui.select.cancel", "back")}`,
			);
		}
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed || this.suspended || this.pending) return undefined;
		if (
			!this.activeAction &&
			event.y === this.searchStartRow &&
			event.button === "left" &&
			(event.type === "press" || event.type === "click")
		) {
			this.searchFocused = true;
			this.focused = this.focusedValue;
			return this.searchInput.handleMouse({ ...event, y: 0 });
		}
		const list = this.activeAction ? this.completions : this.list;
		const startRow = this.activeAction ? this.completionStartRow : this.listStartRow;
		if (!list || event.y < startRow) return undefined;
		const result = list.handleMouse({ ...event, y: event.y - startRow });
		if (result?.handled && !this.activeAction) {
			this.searchFocused = false;
			this.focused = this.focusedValue;
		}
		return result;
	}

	handleInput(data: string): void {
		if (this.disposed || this.suspended) return;
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.back();
			return;
		}
		if (this.pending) return;
		if (!this.activeAction && this.options.onSelectionChange) {
			if (kb.matches(data, "app.models.selectAll") || kb.matches(data, "app.models.clearSelection")) {
				this.options.onSelectionChange(
					this.filteredActions()
						.filter((action) => action.checked !== undefined)
						.map((action) => action.id),
					kb.matches(data, "app.models.selectAll"),
				);
				return;
			}
			if (kb.matches(data, "app.panel.focusNext")) {
				this.searchFocused = !this.searchFocused;
				this.focused = this.focusedValue;
				this.options.requestRender();
				return;
			}
			if (!this.searchFocused && kb.matches(data, "app.models.toggle")) {
				const action = this.actions.find((candidate) => candidate.id === this.getSelectedId());
				if (action?.checked !== undefined) this.selectAction(action.id);
				return;
			}
		}
		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			const input = this.activeAction ? this.argumentInput : this.searchInput;
			if (input.getValue() === "") {
				this.back();
				return;
			}
		}
		if (this.activeAction) {
			if (this.completions && (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down"))) {
				this.completions.handleInput(data);
			} else if (this.completions && kb.matches(data, "tui.input.tab")) {
				this.applyCompletion();
			} else if (kb.matches(data, "tui.input.tab")) {
				void this.updateCompletions(true);
			} else if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				void this.execute(this.activeAction, this.argumentInput.getValue());
			} else {
				const previous = this.argumentInput.getValue();
				this.argumentInput.handleInput(data);
				if (previous !== this.argumentInput.getValue()) {
					this.error = undefined;
					void this.updateCompletions();
				}
			}
		} else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			this.searchFocused = false;
			this.focused = this.focusedValue;
			this.list.handleInput(data);
		} else if (kb.matches(data, "app.command.arguments")) {
			const action = this.actions.find((candidate) => candidate.id === this.getSelectedId());
			if (action && action.argumentMode !== "none") this.openArguments(action);
		} else if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			this.selectAction(this.list.getSelectedItem()?.value);
		} else {
			const previous = this.searchInput.getValue();
			this.searchInput.handleInput(data);
			if (previous !== this.searchInput.getValue()) {
				this.searchFocused = true;
				this.focused = this.focusedValue;
				this.error = undefined;
				this.updateList();
			}
		}
		this.options.requestRender();
	}

	private buildList(actions: readonly CommandPanelAction[]): SelectList {
		const items: SelectItem[] = actions.map((action) => ({
			value: action.id,
			label: `${action.checked === undefined ? "" : action.checked ? "[x] " : "[ ] "}${action.name}`,
			description: [action.source, action.description].filter(Boolean).join(" · "),
		}));
		const list = new SelectList(items, 10, getSelectListTheme(), {
			minPrimaryColumnWidth: 16,
			maxPrimaryColumnWidth: 42,
		});
		list.onSelect = (item) => this.selectAction(item.value);
		return list;
	}

	private selectAction(id: string | undefined): void {
		if (this.disposed || this.suspended || this.pending) return;
		const action = this.actions.find((candidate) => candidate.id === id);
		if (!action) return;
		if (action.argumentMode === "none" || action.argumentMode === "optional") void this.execute(action, "");
		else this.openArguments(action);
	}

	private filteredActions(): readonly CommandPanelAction[] {
		const query = this.searchInput.getValue();
		return query
			? fuzzyFilter(
					[...this.actions],
					query,
					(action) => action.searchText ?? `${action.name} ${action.source ?? ""} ${action.description ?? ""}`,
				)
			: this.actions;
	}

	private updateList(selectedId = this.getSelectedId()): void {
		const filtered = this.filteredActions();
		this.list = this.buildList(filtered);
		const selectedIndex = filtered.findIndex((action) => action.id === selectedId);
		if (selectedIndex >= 0) this.list.setSelectedIndex(selectedIndex);
	}

	private openArguments(action: CommandPanelAction): void {
		this.activeAction = action;
		const initial = action.initialArgs ?? "";
		this.argumentInput.setValue(initial, initial.length);
		this.searchInput.focused = false;
		this.argumentInput.focused = this.focusedValue;
		this.completions = undefined;
		this.error = undefined;
		void this.updateCompletions();
	}

	private back(): void {
		this.executionVersion += 1;
		this.pending = false;
		this.messagePending = false;
		if (this.activeAction) {
			this.completionVersion += 1;
			this.completionController?.abort();
			this.activeAction = undefined;
			this.completions = undefined;
			this.argumentInput.focused = false;
			this.searchInput.focused = this.focusedValue;
			this.error = undefined;
		} else {
			this.suspend();
			this.options.onCancel();
		}
		this.options.requestRender();
	}

	private async updateCompletions(force = false): Promise<void> {
		const version = ++this.completionVersion;
		this.completionController?.abort();
		const action = this.activeAction;
		if (!action?.getArgumentCompletions) {
			this.completions = undefined;
			return;
		}
		const input = this.argumentInput.getValue();
		const controller = new AbortController();
		this.completionController = controller;
		let suggestions: AutocompleteItem[] | null;
		try {
			suggestions = await action.getArgumentCompletions(input, controller.signal, force);
		} catch (error) {
			if (!this.disposed && !this.suspended && version === this.completionVersion) {
				this.error = error instanceof Error ? error.message : String(error);
				this.options.requestRender();
			}
			return;
		}
		if (this.disposed || this.suspended || version !== this.completionVersion || this.activeAction?.id !== action.id)
			return;
		this.completions = suggestions?.length
			? new SelectList(suggestions, 5, getSelectListTheme(), {
					minPrimaryColumnWidth: 16,
					maxPrimaryColumnWidth: 42,
				})
			: undefined;
		if (this.completions) this.completions.onSelect = () => this.applyCompletion();
		this.options.requestRender();
	}

	private applyCompletion(): void {
		const selected = this.completions?.getSelectedItem();
		if (!selected) return;
		this.argumentInput.setValue(selected.value, selected.value.length);
		this.completions = undefined;
		void this.updateCompletions();
	}

	private async execute(action: CommandPanelAction, args: string): Promise<void> {
		const version = ++this.executionVersion;
		this.pending = true;
		try {
			const result = await action.execute(args);
			if (this.disposed || version !== this.executionVersion) return;
			this.error = undefined;
			if (result === "message") {
				if (this.suspended) this.messagePending = true;
				else this.options.onMessage();
			} else if (result !== "edit" && this.activeAction?.id === action.id) {
				this.back();
			}
		} catch (error) {
			if (!this.disposed && version === this.executionVersion)
				this.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (!this.disposed && version === this.executionVersion) {
				this.pending = false;
				if (!this.suspended) this.options.requestRender();
			}
		}
	}
}
