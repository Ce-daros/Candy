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
	visibleWidth,
	wrapTextWithAnsi,
} from "@candy/tui";
import { dialogTitle, getSelectListTheme, theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

export interface CommandPanelAction {
	id: string;
	name: string;
	description?: string;
	source?: string;
	searchText?: string;
	checked?: boolean;
	group?: string;
	status?: {
		text: string;
		tone: "muted" | "success" | "error";
		detail?: string;
	};
	inline?: boolean;
	reset?: () => Promise<void>;
	cycle?: (direction: 1 | -1) => Promise<void>;
	toggle?: () => Promise<void>;
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
	searchable?: boolean;
}

export class CommandPanel implements Component, Focusable {
	private actions: readonly CommandPanelAction[];
	private readonly options: CommandPanelOptions;
	private readonly searchInput: Input;
	private readonly argumentInput = new Input({ prompt: "> " });
	private list: SelectList;
	private completions: SelectList | undefined;
	private activeAction: CommandPanelAction | undefined;
	private inlineEditing = false;
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
	private detailFocused = false;
	private detailOffset = 0;
	private currentDetail = "";
	private renderedWidth = 80;

	constructor(actions: readonly CommandPanelAction[], options: CommandPanelOptions) {
		this.actions = actions;
		this.options = options;
		this.searchInput = new Input({
			prompt: options.title === undefined || options.title === "Command" ? "/ " : "Search: ",
		});
		this.searchFocused = options.searchable !== false && !options.onSelectionChange;
		this.description = options.description ?? "";
		this.list = this.buildList(actions);
	}

	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		this.focusedValue = value;
		this.searchInput.focused = value && !this.activeAction && this.searchFocused;
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
		if (!this.activeAction) this.inlineEditing = false;
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
		if (width !== this.renderedWidth) {
			this.renderedWidth = width;
			if (this.inlineEditing) this.updateList(this.activeAction?.id);
		}
		const title =
			this.activeAction && !this.inlineEditing
				? `${this.options.title ?? "Command"} · ${this.activeAction.name}`
				: (this.options.title ?? "Command");
		const lines = new Text(dialogTitle(title), 0, 0).render(width);
		if (this.description) {
			const descriptionLines = new Text(theme.fg("muted", this.description), 0, 0).render(width);
			lines.push(...descriptionLines.slice(0, Math.max(0, this.availableHeight - 5)));
		}
		if (this.description) lines.push("");
		if (this.activeAction && !this.inlineEditing) {
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
			if (this.options.searchable !== false) {
				this.searchStartRow = lines.length;
				lines.push(...this.searchInput.render(width));
				lines.push("");
			} else this.searchStartRow = -1;
			this.listStartRow = lines.length;
			const selectionHints = this.options.onSelectionChange
				? new Text(
						`${keyHint("app.models.toggle", "toggle")}  ${keyHint("app.models.selectAll", "select matching")}  ${keyHint("app.models.clearSelection", "clear matching")}`,
						0,
						0,
					).render(width)
				: [];
			const selectedAction = this.actions.find((action) => action.id === this.getSelectedId());
			const settingHintParts =
				selectedAction && !this.searchFocused
					? [
							...(selectedAction.cycle
								? [keyHint("app.settings.previous", "previous"), keyHint("app.settings.next", "next")]
								: []),
							...(selectedAction.reset ? [keyHint("app.settings.reset", "reset")] : []),
							...(selectedAction.toggle ? [keyHint("app.models.toggle", "toggle")] : []),
						]
					: [];
			const settingHints = settingHintParts.length ? new Text(settingHintParts.join("  "), 0, 0).render(width) : [];
			const detail = this.error ?? selectedAction?.status?.detail ?? "";
			if (detail !== this.currentDetail) {
				this.currentDetail = detail;
				this.detailOffset = 0;
				this.detailFocused = false;
			}
			const detailLines = detail ? wrapTextWithAnsi(this.error ? theme.fg("error", detail) : detail, width) : [];
			const footerLabel = `${keyHint("tui.select.up", "up")} ${keyHint("tui.select.down", "down")}  ${detail ? `${keyHint("app.panel.focusNext", this.detailFocused ? "list" : "details")}  ` : this.options.onSelectionChange ? `${keyHint("app.panel.focusNext", this.searchFocused ? "list" : "search")}  ` : ""}${keyHint("tui.select.confirm", this.inlineEditing ? "save" : "select")}  ${selectedAction?.argumentMode === "optional" ? `${keyHint("app.command.arguments", "arguments")}  ` : ""}${keyHint("tui.select.cancel", this.inlineEditing ? "cancel edit" : "back")}`;
			const footerLines = new Text(footerLabel, 0, 0).render(width);
			const detailCapacity = Math.floor(this.availableHeight / 3);
			const selectionGap = selectionHints.length ? 1 : 0;
			const detailRoom =
				this.availableHeight -
				lines.length -
				selectionHints.length -
				settingHints.length -
				selectionGap -
				footerLines.length -
				4;
			let detailScrollRows = Math.min(
				detailLines.length,
				detailCapacity,
				Math.max(detailLines.length ? 1 : 0, detailRoom),
			);
			let hasDetailScroll = detailLines.length > detailScrollRows;
			if (hasDetailScroll && detailScrollRows > 1) detailScrollRows -= 1;
			hasDetailScroll = detailLines.length > detailScrollRows;
			const detailHintRows = hasDetailScroll ? 1 : 0;
			this.detailOffset = Math.min(this.detailOffset, Math.max(0, detailLines.length - detailScrollRows));
			const listCapacity =
				this.availableHeight -
				lines.length -
				selectionHints.length -
				selectionGap -
				settingHints.length -
				detailScrollRows -
				detailHintRows -
				footerLines.length;
			const filtered = this.filteredActions();
			const actionRows =
				filtered.length +
				(this.searchInput.getValue()
					? 0
					: filtered.filter((action, index) => action.group && action.group !== filtered[index - 1]?.group)
							.length);
			const listScrollRows = actionRows > listCapacity ? 1 : 0;
			this.list.setMaxVisible(Math.max(1, listCapacity - listScrollRows));
			lines.push(...this.list.render(width));
			if (detailLines.length) {
				lines.push(...detailLines.slice(this.detailOffset, this.detailOffset + detailScrollRows));
				if (hasDetailScroll)
					lines.push(
						...new Text(
							`${keyHint("tui.select.up", "up")} ${keyHint("tui.select.down", "down")}  ${this.detailOffset + 1}–${Math.min(this.detailOffset + detailScrollRows, detailLines.length)} / ${detailLines.length}`,
							0,
							0,
						).render(width),
					);
			}
			if (selectionHints.length) lines.push("");
			lines.push(...selectionHints);
			lines.push(...settingHints);
			lines.push(...footerLines);
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
		const selectedAction = !this.activeAction
			? this.actions.find((candidate) => candidate.id === this.getSelectedId())
			: undefined;
		if ((this.error || selectedAction?.status?.detail) && kb.matches(data, "app.panel.focusNext")) {
			this.detailFocused = !this.detailFocused;
			this.options.requestRender();
			return;
		}
		if (!this.activeAction && this.options.searchable !== false && kb.matches(data, "app.panel.focusNext")) {
			this.searchFocused = !this.searchFocused;
			this.focused = this.focusedValue;
			this.options.requestRender();
			return;
		}
		if (this.detailFocused && (this.error || selectedAction?.status?.detail)) {
			if (kb.matches(data, "tui.select.up")) this.detailOffset = Math.max(0, this.detailOffset - 1);
			else if (kb.matches(data, "tui.select.down")) this.detailOffset += 1;
			this.options.requestRender();
			return;
		}
		if (!this.activeAction && !this.searchFocused) {
			const action = selectedAction;
			if (action?.reset && kb.matches(data, "app.settings.reset")) {
				void this.runInlineAction(() => action.reset?.());
				return;
			}
			if (action?.cycle && kb.matches(data, "app.settings.next")) {
				void this.runInlineAction(() => action.cycle?.(1));
				return;
			}
			if (action?.cycle && kb.matches(data, "app.settings.previous")) {
				void this.runInlineAction(() => action.cycle?.(-1));
				return;
			}
			if (action?.toggle && kb.matches(data, "app.models.toggle")) {
				void this.runInlineAction(() => action.toggle?.());
				return;
			}
		}
		if (!this.activeAction && this.options.onSelectionChange) {
			if (kb.matches(data, "app.models.selectAll") || kb.matches(data, "app.models.clearSelection")) {
				try {
					this.options.onSelectionChange(
						this.filteredActions()
							.filter((action) => action.checked !== undefined)
							.map((action) => action.id),
						kb.matches(data, "app.models.selectAll"),
					);
					this.error = undefined;
				} catch (error) {
					this.error = error instanceof Error ? error.message : String(error);
				}
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
			if (this.inlineEditing) {
				if (kb.matches(data, "tui.select.confirm") || data === "\n") {
					void this.execute(this.activeAction, this.argumentInput.getValue());
				} else {
					const previous = this.argumentInput.getValue();
					this.argumentInput.handleInput(data);
					if (previous !== this.argumentInput.getValue()) this.updateList(this.activeAction.id);
				}
			} else if (this.completions && (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down"))) {
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
		} else if (this.options.searchable !== false) {
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
		const query = this.searchInput.getValue();
		const items: SelectItem[] = [];
		let previousGroup: string | undefined;
		for (const [index, action] of actions.entries()) {
			const group = query ? undefined : action.group;
			if (group && group !== previousGroup) {
				items.push({
					value: `__group:${index}`,
					label: theme.bold(theme.fg("warning", group)),
					header: true,
					selectable: false,
				});
				previousGroup = group;
			} else if (!group) previousGroup = undefined;
			const tone = action.status?.tone ?? "muted";
			const status = action.status ? theme.fg(tone, action.status.text) : undefined;
			const editing = this.inlineEditing && this.activeAction?.id === action.id;
			const inlineLabelWidth = visibleWidth(`${action.checked === undefined ? "" : "[x] "}${action.name}`);
			const inputWidth = Math.max(1, this.renderedWidth - inlineLabelWidth - 6);
			const inlineInput = editing ? this.argumentInput.render(inputWidth)[0] : undefined;
			const inlineValue = inlineInput ? `  ${inlineInput}` : "";
			items.push({
				value: action.id,
				checked: action.checked,
				label: `${action.name}${inlineValue}`,
				description: editing ? undefined : [status, action.source, action.description].filter(Boolean).join(" · "),
			});
		}
		const list = new SelectList(items, 10, getSelectListTheme(), {
			minPrimaryColumnWidth: 16,
			maxPrimaryColumnWidth: 42,
		});
		list.setSelectedIndex(0);
		list.onSelect = (item) => this.selectAction(item.value);
		return list;
	}

	private async runInlineAction(operation: () => Promise<void> | undefined): Promise<void> {
		if (this.pending) return;
		this.pending = true;
		this.options.requestRender();
		try {
			await operation();
			this.error = undefined;
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.pending = false;
			this.options.requestRender();
		}
	}

	private selectAction(id: string | undefined): void {
		if (this.disposed || this.suspended || this.pending) return;
		if (!id || id.startsWith("__group:")) return;
		const action = this.actions.find((candidate) => candidate.id === id);
		if (!action) return;
		if (action.inline) this.openInlineArguments(action);
		else if (action.argumentMode === "none" || action.argumentMode === "optional") void this.execute(action, "");
		else this.openArguments(action);
	}

	private openInlineArguments(action: CommandPanelAction): void {
		this.activeAction = action;
		this.inlineEditing = true;
		this.argumentInput.setValue(action.initialArgs ?? "", (action.initialArgs ?? "").length);
		this.argumentInput.focused = this.focusedValue;
		this.error = undefined;
		this.updateList(action.id);
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
		if (selectedId) this.list.setSelectedValue(selectedId);
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
			const selectedId = this.activeAction.id;
			this.inlineEditing = false;
			this.completionVersion += 1;
			this.completionController?.abort();
			this.activeAction = undefined;
			this.completions = undefined;
			this.argumentInput.focused = false;
			this.searchInput.focused = this.focusedValue;
			this.error = undefined;
			this.updateList(selectedId);
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
