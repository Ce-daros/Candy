import { type Model, modelsAreEqual } from "@candy/ai";
import {
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@candy/tui";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { getModelSelectorSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface DefaultModelReference {
	provider: string;
	id: string;
}

type Region = "providers" | "models" | "search";

export class ModelSelectorComponent implements Focusable {
	invalidate(): void {}
	private readonly searchInput = new Input();
	private readonly tui: TUI;
	private readonly modelRuntime: ModelRuntime;
	private readonly currentModel?: Model<any>;
	private readonly defaultModel?: DefaultModelReference;
	private readonly onSelectCallback: (model: Model<any>) => void;
	private readonly onSelectAsDefaultCallback?: (model: Model<any>) => void;
	private readonly onCancelCallback: () => void;
	private readonly refreshAbortController = new AbortController();
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	private allModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private providers: string[] = ["All"];
	private providerIndex = 0;
	private selectedIndex = 0;
	private region: Region = "models";
	private availableHeight = 20;
	private errorMessage?: string;
	private refreshStatusMessage = "Refreshing model catalogs…";
	private refreshStatusSuccess = false;
	private closed = false;
	private _focused = false;
	private lastWide = false;
	private lastPaneWidth = 0;
	private lastModelStart = 0;
	private lastSearchRow = 0;
	private lastProviderStart = 0;
	private lastVisibleStart = 0;
	private lastVisibleRows = 0;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.region === "search";
	}

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		modelRuntime: ModelRuntime,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		onSelectAsDefault?: (model: Model<any>) => void,
		defaultModel?: DefaultModelReference,
	) {
		this.tui = tui;
		this.currentModel = currentModel;
		this.modelRuntime = modelRuntime;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onSelectAsDefaultCallback = onSelectAsDefault;
		this.defaultModel = defaultModel;
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
			this.region = "search";
		}
		this.searchInput.onSubmit = () => this.selectCurrent();
		this.loadModelsFromSnapshot();
		this.filterModels(this.searchInput.getValue());
		this.tui.requestRender();
		void this.refreshModels();
	}

	setAvailableHeight(height: number): void {
		this.availableHeight = Math.max(8, height);
	}

	private loadModelsFromSnapshot(): void {
		this.allModels = this.modelRuntime.getAvailableSnapshot().map((model) => ({
			provider: model.provider,
			id: model.id,
			model,
		}));
		this.allModels.sort((a, b) => {
			const aCurrent = modelsAreEqual(this.currentModel, a.model);
			const bCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
			const aDefault = this.isDefaultModel(a.model);
			const bDefault = this.isDefaultModel(b.model);
			if (aDefault !== bDefault) return aDefault ? -1 : 1;
			return a.provider.localeCompare(b.provider) || a.model.name.localeCompare(b.model.name);
		});
		const previous = this.providers[this.providerIndex];
		this.providers = ["All", ...[...new Set(this.allModels.map((item) => item.provider))].sort()];
		this.providerIndex = Math.max(0, this.providers.indexOf(previous));
	}

	private async refreshModels(): Promise<void> {
		let timedOut = false;
		this.refreshTimeout = setTimeout(() => {
			timedOut = true;
			this.refreshAbortController.abort();
		}, 15_000);
		try {
			const result = await refreshModelCatalogs(this.modelRuntime, this.refreshAbortController.signal);
			if (this.closed) return;
			this.refreshStatusMessage = "";
			if (result.aborted && timedOut) {
				this.errorMessage = "Model refresh timed out; showing cached models.";
			} else if (result.errors.size === 1) {
				this.errorMessage = `Could not refresh ${result.errors.keys().next().value}; showing cached models.`;
			} else if (result.errors.size > 1) {
				this.errorMessage = `Could not refresh ${result.errors.size} model catalogs (${[...result.errors.keys()].join(", ")}); showing cached models.`;
			} else {
				this.errorMessage = this.modelRuntime.getError();
				if (!this.errorMessage) {
					this.refreshStatusMessage = "Model catalogs refreshed.";
					this.refreshStatusSuccess = true;
				}
			}
			this.loadModelsFromSnapshot();
			this.filterModels(this.searchInput.getValue());
			this.tui.requestRender();
		} catch (error) {
			if (this.closed) return;
			this.refreshStatusMessage = "";
			this.errorMessage = timedOut
				? "Model refresh timed out; showing cached models."
				: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
			this.tui.requestRender();
		} finally {
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		this.refreshAbortController.abort();
	}

	private isDefaultModel(model: Model<any>): boolean {
		return this.defaultModel?.provider === model.provider && this.defaultModel.id === model.id;
	}

	private filterModels(query: string): void {
		const provider = this.providers[this.providerIndex];
		const available =
			provider === "All" ? this.allModels : this.allModels.filter((item) => item.provider === provider);
		const filtered = query
			? fuzzyFilter(
					available,
					query,
					(item) =>
						`${getModelSelectorSearchText({ id: item.id, provider: item.provider, name: item.model.name })}${this.isDefaultModel(item.model) ? " default" : ""}`,
				)
			: available;
		if (query.trim() && "default".startsWith(query.trim().toLowerCase())) {
			const defaults = available.filter((item) => this.isDefaultModel(item.model));
			const defaultKeys = new Set(defaults.map((item) => `${item.provider}\0${item.id}`));
			this.filteredModels = [
				...defaults,
				...filtered.filter((item) => !defaultKeys.has(`${item.provider}\0${item.id}`)),
			];
		} else {
			this.filteredModels = filtered;
		}
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private selectCurrent(): void {
		const selected = this.filteredModels[this.selectedIndex];
		if (!selected) return;
		this.dispose();
		this.onSelectCallback(selected.model);
	}

	private moveSelection(delta: number): void {
		if (this.region === "providers") {
			this.providerIndex = (this.providerIndex + delta + this.providers.length) % this.providers.length;
			this.selectedIndex = 0;
			this.filterModels(this.searchInput.getValue());
		} else if (this.filteredModels.length > 0) {
			this.selectedIndex = (this.selectedIndex + delta + this.filteredModels.length) % this.filteredModels.length;
		}
	}

	render(width: number): string[] {
		const wide = width >= 100;
		const paneWidth = wide ? Math.min(22, Math.floor(width * 0.23)) : width;
		const bodyWidth = wide ? width - paneWidth - 3 : width;
		const rows = Math.max(3, this.availableHeight - 8 - (wide ? 0 : 2));
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(rows / 2), this.filteredModels.length - rows));
		const providerStart = Math.max(
			0,
			Math.min(this.providerIndex - Math.floor(rows / 2), this.providers.length - rows),
		);
		this.lastWide = wide;
		this.lastPaneWidth = paneWidth;
		this.lastProviderStart = providerStart;
		this.lastModelStart = wide ? 2 : 4;
		this.lastVisibleStart = start;
		this.lastVisibleRows = rows;
		const names = new Map<string, number>();
		for (const item of this.allModels) {
			const key = `${item.provider}\0${item.model.name}`;
			names.set(key, (names.get(key) ?? 0) + 1);
		}
		const providerLine = (index: number): string => {
			const selected = index === this.providerIndex;
			const active = selected && this.region === "providers";
			const name = active
				? theme.bold(theme.fg("accent", this.providers[index]))
				: selected
					? theme.fg("accent", this.providers[index])
					: theme.fg("muted", this.providers[index]);
			const value = `${selected ? theme.fg("borderAccent", "♦ ") : "  "}${name}${selected ? theme.fg("borderAccent", " ♦") : ""}`;
			return truncateToWidth(value, paneWidth);
		};
		const modelLine = (index: number): string => {
			const item = this.filteredModels[index];
			if (!item) return "";
			const selected = index === this.selectedIndex;
			const suffix = names.get(`${item.provider}\0${item.model.name}`)! > 1 ? ` · ${item.id}` : "";
			const status = `${modelsAreEqual(this.currentModel, item.model) ? "✓" : " "}${this.isDefaultModel(item.model) ? " · default" : ""}`;
			const name = `${item.model.name}${suffix}  ${status}`;
			const label = selected
				? `${theme.fg("borderAccent", "♦ ")}${theme.bold(theme.fg("accent", name))}${theme.fg("borderAccent", " ♦")}`
				: `  ${name}`;
			return truncateToWidth(label, bodyWidth);
		};
		const lines = [theme.bold(theme.fg("accent", "Model")), ""];
		if (wide) {
			for (let row = 0; row < rows; row++) {
				const providerIndex = providerStart + row;
				const left = providerIndex < this.providers.length ? providerLine(providerIndex) : "";
				const right = start + row < this.filteredModels.length ? modelLine(start + row) : "";
				lines.push(
					`${left}${" ".repeat(Math.max(0, paneWidth - visibleWidth(left)))} ${theme.fg("borderMuted", "│")} ${right}`,
				);
			}
		} else {
			let strip = this.providerIndex > 0 ? theme.fg("muted", "‹ ") : "";
			for (let index = this.providerIndex; index < this.providers.length; index++) {
				const next = `${strip}${index > this.providerIndex ? "  " : ""}${providerLine(index)}`;
				if (visibleWidth(next) > width) break;
				strip = next;
			}
			lines.push(truncateToWidth(strip, width));
			lines.push(theme.fg("borderMuted", "─".repeat(width)));
			for (let row = 0; row < rows; row++) lines.push(modelLine(start + row));
		}
		if (this.filteredModels.length === 0) lines.push(theme.fg("muted", "No matching models"));
		const selected = this.filteredModels[this.selectedIndex];
		lines.push(theme.fg("borderMuted", "─".repeat(width)));
		if (selected) {
			lines.push(truncateToWidth(theme.fg("muted", `${selected.provider}/${selected.id}`), width));
			lines.push(
				truncateToWidth(
					theme.fg(
						"muted",
						`Context ${selected.model.contextWindow.toLocaleString()} · Output ${selected.model.maxTokens.toLocaleString()} · Thinking ${selected.model.reasoning ? "Yes" : "No"}`,
					),
					width,
				),
			);
		} else lines.push("");
		if (this.errorMessage) lines.push(truncateToWidth(theme.fg("error", this.errorMessage), width));
		else if (this.refreshStatusMessage)
			lines.push(
				truncateToWidth(
					theme.fg(this.refreshStatusSuccess ? "success" : "muted", this.refreshStatusMessage),
					width,
				),
			);
		this.lastSearchRow = lines.length;
		lines.push(...this.searchInput.render(width));
		lines.push(
			theme.fg(
				"dim",
				`Tab panels · ${keyDisplayText("tui.select.confirm")} select${this.onSelectAsDefaultCallback ? ` · ${keyDisplayText("app.models.save")} set default` : ""} · Esc close`,
			),
		);
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			this.region = "models";
			this.moveSelection(event.wheelDelta < 0 ? -1 : 1);
			return { handled: true, render: true };
		}
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		if (event.y === this.lastSearchRow) {
			this.region = "search";
			return this.searchInput.handleMouse?.({ ...event, y: 0 });
		}
		if (this.lastWide && event.x < this.lastPaneWidth && event.y >= 2 && event.y < 2 + this.lastVisibleRows) {
			const index = this.lastProviderStart + event.y - 2;
			if (index >= this.providers.length) return undefined;
			this.providerIndex = index;
			this.selectedIndex = 0;
			this.filterModels(this.searchInput.getValue());
			this.region = "providers";
			return { handled: true, focus: true, render: true };
		}
		if (
			event.y >= this.lastModelStart &&
			event.y < this.lastModelStart + this.lastVisibleRows &&
			(!this.lastWide || event.x > this.lastPaneWidth + 1)
		) {
			const index = this.lastVisibleStart + event.y - this.lastModelStart;
			if (index >= this.filteredModels.length) return undefined;
			this.region = "models";
			this.selectedIndex = index;
			if (event.type === "click") this.selectCurrent();
			return { handled: true, focus: true, render: true };
		}
		return undefined;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.panel.focusNext") || kb.matches(data, "app.panel.focusPrevious")) {
			const regions: Region[] = ["providers", "models", "search"];
			const delta = kb.matches(data, "app.panel.focusNext") ? 1 : -1;
			this.region = regions[(regions.indexOf(this.region) + delta + regions.length) % regions.length];
			this.searchInput.focused = this._focused && this.region === "search";
		} else if (kb.matches(data, "tui.select.up")) this.moveSelection(-1);
		else if (kb.matches(data, "tui.select.down")) this.moveSelection(1);
		else if (kb.matches(data, "tui.select.confirm")) {
			if (this.region === "providers") this.region = "models";
			else this.selectCurrent();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.dispose();
			this.onCancelCallback();
		} else if (kb.matches(data, "app.models.save") && this.onSelectAsDefaultCallback) {
			const selected = this.filteredModels[this.selectedIndex];
			if (selected) {
				this.dispose();
				this.onSelectAsDefaultCallback(selected.model);
			}
		} else {
			this.region = "search";
			this.searchInput.focused = this._focused;
			this.searchInput.handleInput(data);
			this.filterModels(this.searchInput.getValue());
		}
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
