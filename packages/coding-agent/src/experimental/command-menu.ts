import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	SelectList,
	type SelectListTheme,
	Text,
} from "@candy/tui";
import { keyHint } from "../modes/interactive/components/keybinding-hints.ts";
import { theme } from "../modes/interactive/theme/theme.ts";

export interface CommandMenuItem {
	readonly name: string;
	readonly source: string;
	readonly description?: string;
	readonly argumentHint?: string;
}

const selectTheme: SelectListTheme = {
	selectedPrefix: (text) => theme.fg("accent", text),
	selectedText: (text) => theme.fg("accent", text),
	description: (text) => theme.fg("muted", text),
	scrollInfo: (text) => theme.fg("dim", text),
	noMatch: (text) => theme.fg("warning", text),
};

export class CommandMenu extends Container implements Focusable {
	readonly #items: readonly CommandMenuItem[];
	readonly #search = new Input({ prompt: "/ " });
	readonly #args = new Input({ prompt: "> " });
	readonly #listContainer = new Container();
	readonly #title = new Text("Command", 1, 0);
	readonly #hint = new Text(this.#listHint(), 1, 0);
	readonly #onRun: (item: CommandMenuItem, args: string) => Promise<boolean> | boolean;
	readonly #onClose: () => void;
	#list: SelectList;
	#visibleItems: readonly CommandMenuItem[] = [];
	#selected: CommandMenuItem | undefined;
	#focused = false;
	#executionVersion = 0;
	#pending = false;
	#closed = false;

	constructor(
		items: readonly CommandMenuItem[],
		onRun: (item: CommandMenuItem, args: string) => Promise<boolean> | boolean,
		onClose: () => void,
	) {
		super();
		this.#items = items;
		this.#onRun = onRun;
		this.#onClose = onClose;
		this.#list = this.#buildList(items);
		this.addChild(this.#title);
		this.addChild(this.#search);
		this.addChild(this.#listContainer);
		this.addChild(this.#hint);
		this.#args.onSubmit = (args) => void this.#run(args);
	}

	get focused(): boolean {
		return this.#focused;
	}

	#listHint(): string {
		return `${keyHint("tui.select.confirm", "run")} · ${keyHint("app.command.arguments", "arguments")} · ${keyHint("tui.select.cancel", "back")}`;
	}

	set focused(value: boolean) {
		this.#focused = value;
		this.#search.focused = value && this.#selected === undefined;
		this.#args.focused = value && this.#selected !== undefined;
	}

	handleInput(data: string): void {
		const bindings = getKeybindings();
		if (bindings.matches(data, "tui.select.cancel")) {
			this.#selected === undefined ? this.#close() : this.#showList();
			return;
		}
		if (bindings.matches(data, "tui.editor.deleteCharBackward")) {
			const input = this.#selected === undefined ? this.#search : this.#args;
			if (input.getValue().length === 0) {
				this.#selected === undefined ? this.#close() : this.#showList();
				return;
			}
		}
		if (this.#selected !== undefined) {
			this.#args.handleInput(data);
			return;
		}
		if (bindings.matches(data, "app.command.arguments")) {
			const selected = this.#list.getSelectedItem();
			const item = selected === null ? undefined : this.#visibleItems[Number(selected.value)];
			if (item !== undefined && (item.source !== "local" || item.argumentHint !== undefined)) {
				this.#showArguments(item);
			}
			return;
		}
		if (
			bindings.matches(data, "tui.select.up") ||
			bindings.matches(data, "tui.select.down") ||
			bindings.matches(data, "tui.select.confirm")
		) {
			this.#list.handleInput(data);
			return;
		}
		this.#search.handleInput(data);
		const query = this.#search.getValue();
		this.#list = this.#buildList(
			query.length === 0
				? this.#items
				: fuzzyFilter([...this.#items], query, (item) => `${item.name} ${item.description ?? ""} ${item.source}`),
		);
	}

	#buildList(items: readonly CommandMenuItem[]): SelectList {
		this.#visibleItems = items;
		const list = new SelectList(
			items.map((item, index) => ({
				value: String(index),
				label: item.name,
				description: `${item.source}${item.description === undefined ? "" : ` · ${item.description}`}`,
			})),
			10,
			selectTheme,
		);
		list.onSelect = (selected) => {
			const item = items[Number(selected.value)];
			if (item === undefined) return;
			if (item.source === "local" && item.argumentHint !== undefined) this.#showArguments(item);
			else void this.#execute(item, "");
		};
		this.#listContainer.clear();
		this.#listContainer.addChild(list);
		return list;
	}

	#showArguments(item: CommandMenuItem): void {
		this.#selected = item;
		this.#title.setText(item.name);
		this.#hint.setText(`${keyHint("tui.select.confirm", "run")} · ${keyHint("tui.select.cancel", "back")}`);
		this.#args.focused = this.#focused;
		this.#search.focused = false;
		this.#listContainer.clear();
		this.#listContainer.addChild(this.#args);
	}

	#showList(): void {
		this.#executionVersion++;
		this.#pending = false;
		this.#selected = undefined;
		this.#title.setText("Command");
		this.#hint.setText(this.#listHint());
		this.#args.setValue("");
		this.#args.focused = false;
		this.#search.focused = this.#focused;
		this.#listContainer.clear();
		this.#listContainer.addChild(this.#list);
	}

	async #run(args: string): Promise<void> {
		const selected = this.#selected;
		if (selected !== undefined) await this.#execute(selected, args);
	}

	async #execute(item: CommandMenuItem, args: string): Promise<void> {
		if (this.#pending) return;
		const version = ++this.#executionVersion;
		this.#pending = true;
		try {
			if ((await this.#onRun(item, args)) && version === this.#executionVersion && !this.#closed) this.#close();
		} finally {
			if (version === this.#executionVersion) this.#pending = false;
		}
	}

	#close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#executionVersion++;
		this.#pending = false;
		this.#onClose();
	}
}
