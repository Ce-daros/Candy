/**
 * TUI component for managing package resources (enable/disable)
 */

import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	moveSelection,
	Spacer,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	visibleWindow,
} from "@candy/tui";
import { CONFIG_DIR_NAME } from "../../../config.ts";
import type { PathMetadata, ResolvedPaths, ResolvedResource } from "../../../core/package-manager.ts";
import {
	type ConfigWriteScope,
	ResourceConfiguration,
	type ResourceType,
} from "../../../core/resource-configuration.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { checkboxGlyph, selectedRowLabel, selectionCursor, selectionMarkerSuffix, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export type ScopedResolvedPaths = Record<ConfigWriteScope, ResolvedPaths>;

export interface ConfigSelectorOptions {
	resourceConfiguration?: ResourceConfiguration;
	resourceTypes?: readonly ResourceType[];
	onToggle?: () => void;
	onOpen?: (path: string) => void;
	beforeToggle?: () => string | undefined;
	title?: string;
	embedded?: boolean;
}

const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const satisfies readonly ResourceType[];

const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
	extensions: "Extensions",
	skills: "Skills",
	prompts: "Prompts",
	themes: "Themes",
};

interface ResourceItem {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
	resourceType: ResourceType;
	displayName: string;
	groupKey: string;
	subgroupKey: string;
}

interface ResourceSubgroup {
	type: ResourceType;
	label: string;
	items: ResourceItem[];
}

interface ResourceGroup {
	key: string;
	label: string;
	scope: "user" | "project" | "temporary";
	origin: "package" | "top-level";
	source: string;
	subgroups: ResourceSubgroup[];
}

function formatBaseDir(baseDir: string): string {
	const homeDir = homedir();
	let displayPath: string;

	if (baseDir === homeDir) {
		displayPath = "~";
	} else if (baseDir.startsWith(homeDir)) {
		// Replace home prefix with ~, normalize separators for display
		const rest = baseDir.slice(homeDir.length);
		displayPath = `~${rest.replace(/\\/g, "/")}`;
	} else {
		displayPath = baseDir.replace(/\\/g, "/");
	}

	return displayPath.endsWith("/") ? displayPath : `${displayPath}/`;
}

function getGroupLabel(metadata: PathMetadata, agentDir: string): string {
	if (metadata.origin === "package") {
		return `${metadata.source} (${metadata.scope})`;
	}
	// Top-level resources
	if (metadata.source === "auto") {
		if (metadata.baseDir) {
			return metadata.scope === "user"
				? `User (${formatBaseDir(metadata.baseDir)})`
				: `Project (${formatBaseDir(metadata.baseDir)})`;
		}
		return metadata.scope === "user" ? `User (${formatBaseDir(agentDir)})` : `Project (${CONFIG_DIR_NAME}/)`;
	}
	return metadata.scope === "user" ? "User settings" : "Project settings";
}

function buildGroups(resolved: ResolvedPaths, agentDir: string): ResourceGroup[] {
	const groupMap = new Map<string, ResourceGroup>();

	const addToGroup = (resources: ResolvedResource[], resourceType: ResourceType) => {
		for (const res of resources) {
			const { path, enabled, metadata } = res;
			const groupKey = `${metadata.origin}:${metadata.scope}:${metadata.source}:${metadata.baseDir ?? ""}`;

			if (!groupMap.has(groupKey)) {
				groupMap.set(groupKey, {
					key: groupKey,
					label: getGroupLabel(metadata, agentDir),
					scope: metadata.scope,
					origin: metadata.origin,
					source: metadata.source,
					subgroups: [],
				});
			}

			const group = groupMap.get(groupKey)!;
			const subgroupKey = `${groupKey}:${resourceType}`;

			let subgroup = group.subgroups.find((sg) => sg.type === resourceType);
			if (!subgroup) {
				subgroup = {
					type: resourceType,
					label: RESOURCE_TYPE_LABELS[resourceType],
					items: [],
				};
				group.subgroups.push(subgroup);
			}

			const fileName = basename(path);
			const parentFolder = basename(dirname(path));
			let displayName: string;
			if (resourceType === "extensions" && parentFolder !== "extensions") {
				displayName = `${parentFolder}/${fileName}`;
			} else if (resourceType === "skills" && fileName === "SKILL.md") {
				displayName = parentFolder;
			} else {
				displayName = fileName;
			}
			subgroup.items.push({
				path,
				enabled,
				metadata,
				resourceType,
				displayName,
				groupKey,
				subgroupKey,
			});
		}
	};

	addToGroup(resolved.extensions, "extensions");
	addToGroup(resolved.skills, "skills");
	addToGroup(resolved.prompts, "prompts");
	addToGroup(resolved.themes, "themes");

	// Sort groups: packages first, then top-level; user before project
	const groups = Array.from(groupMap.values());
	groups.sort((a, b) => {
		if (a.origin !== b.origin) {
			return a.origin === "package" ? -1 : 1;
		}
		if (a.scope !== b.scope) {
			return a.scope === "user" ? -1 : 1;
		}
		return a.source.localeCompare(b.source);
	});

	// Sort subgroups within each group by type order, and items by name
	const typeOrder: Record<ResourceType, number> = { extensions: 0, skills: 1, prompts: 2, themes: 3 };
	for (const group of groups) {
		group.subgroups.sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);
		for (const subgroup of group.subgroups) {
			subgroup.items.sort((a, b) => a.displayName.localeCompare(b.displayName));
		}
	}

	return groups;
}

type FlatEntry =
	| { type: "group"; group: ResourceGroup }
	| { type: "subgroup"; subgroup: ResourceSubgroup; group: ResourceGroup }
	| { type: "item"; item: ResourceItem };

class ConfigSelectorHeader implements Component {
	private writeScope: ConfigWriteScope;
	private projectModeAvailable: boolean;
	private title?: string;
	private embedded: boolean;

	constructor(writeScope: ConfigWriteScope, projectModeAvailable: boolean, title?: string, embedded = false) {
		this.writeScope = writeScope;
		this.projectModeAvailable = projectModeAvailable;
		this.title = title;
		this.embedded = embedded;
	}

	setWriteScope(writeScope: ConfigWriteScope): void {
		this.writeScope = writeScope;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const title = theme.bold(
			this.title ?? (this.writeScope === "project" ? "Project Local Resources" : "Global Resources"),
		);
		const sep = theme.fg("muted", " · ");
		const switchHint = this.projectModeAvailable ? keyHint("app.panel.scope", "scope") + sep : "";
		const actionHint =
			this.writeScope === "project" ? rawKeyHint("space", "cycle inherit/+/-") : rawKeyHint("space", "toggle");
		const hint = switchHint + actionHint + sep + rawKeyHint("esc", "close");
		const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(hint));
		const scopeHint =
			this.writeScope === "project"
				? theme.fg("muted", `${CONFIG_DIR_NAME}/settings.json · inherited global resources are dimmed`)
				: theme.fg("muted", `~/${CONFIG_DIR_NAME}/agent/settings.json`);

		return this.embedded
			? [truncateToWidth(`${title}${" ".repeat(spacing)}${hint}`, width, "")]
			: [truncateToWidth(`${title}${" ".repeat(spacing)}${hint}`, width, ""), truncateToWidth(scopeHint, width, "")];
	}
}

class ResourceList implements Component, Focusable {
	private groupsByScope: Record<ConfigWriteScope, ResourceGroup[]>;
	private flatItems: FlatEntry[] = [];
	private filteredItems: FlatEntry[] = [];
	private selectedIndex = 0;
	private searchInput: Input;
	private maxVisible: number;
	private resourceConfiguration: ResourceConfiguration;
	private resourceTypes: readonly ResourceType[];
	private writeScope: ConfigWriteScope;
	private selectedTypeIndex = 0;
	private region: "categories" | "list" | "search" = "list";
	private lastWide = false;
	private lastCategoryWidth = 0;
	private lastVisibleStart = 0;
	private lastVisibleCount = 0;
	private lastSearchRow = 0;
	private toggleError?: string;
	private pendingToggle = false;
	private readonly embedded: boolean;
	private readonly requestRender: () => void;

	public onCancel?: () => void;
	public onExit?: () => void;
	public onToggle?: (item: ResourceItem, newEnabled: boolean) => void;
	public onSwitchMode?: () => void;
	public onOpen?: (path: string) => void;
	public beforeToggle?: () => string | undefined;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.region === "search";
	}

	constructor(
		groupsByScope: Record<ConfigWriteScope, ResourceGroup[]>,
		resourceConfiguration: ResourceConfiguration,
		terminalHeight?: number,
		writeScope: ConfigWriteScope = "global",
		resourceTypes: readonly ResourceType[] = RESOURCE_TYPES,
		embedded = false,
		requestRender: () => void = () => {},
	) {
		this.groupsByScope = groupsByScope;
		this.resourceConfiguration = resourceConfiguration;
		this.resourceTypes = resourceTypes;
		this.embedded = embedded;
		this.requestRender = requestRender;
		this.writeScope = writeScope;
		this.searchInput = new Input();
		this.maxVisible = Math.max(1, (terminalHeight ?? 24) - (embedded ? 11 : 19));
		this.buildFlatList();
		this.filteredItems = [...this.flatItems];
	}

	setWriteScope(writeScope: ConfigWriteScope): void {
		this.writeScope = writeScope;
		this.resourceConfiguration.setWriteScope(writeScope);
		this.buildFlatList();
		this.filterItems(this.searchInput.getValue());
	}

	setAvailableHeight(height: number): void {
		this.maxVisible = Math.max(1, height - (this.embedded ? 11 : 19));
	}

	private get groups(): ResourceGroup[] {
		return this.groupsByScope[this.writeScope];
	}

	private buildFlatList(): void {
		this.flatItems = [];
		for (const group of this.groups) {
			const subgroups = group.subgroups.filter(
				(subgroup) => subgroup.type === this.resourceTypes[this.selectedTypeIndex],
			);
			if (subgroups.length === 0) continue;
			this.flatItems.push({ type: "group", group });
			for (const subgroup of subgroups) {
				if (this.resourceTypes.length > 1) this.flatItems.push({ type: "subgroup", subgroup, group });
				for (const item of subgroup.items) {
					this.flatItems.push({ type: "item", item });
				}
			}
		}
		// Start selection on first item (not header)
		this.selectedIndex = this.flatItems.findIndex((e) => e.type === "item");
		if (this.selectedIndex < 0) this.selectedIndex = 0;
	}

	private findNextItem(fromIndex: number, direction: 1 | -1, wrap = false): number {
		let idx = fromIndex;
		for (let visited = 0; visited < this.filteredItems.length; visited++) {
			const next = moveSelection(idx, this.filteredItems.length, direction, wrap);
			if (next === idx) return fromIndex;
			idx = next;
			if (this.filteredItems[idx].type === "item") {
				return idx;
			}
		}
		return fromIndex;
	}

	private filterItems(query: string): void {
		if (!query.trim()) {
			this.filteredItems = [...this.flatItems];
			this.selectFirstItem();
			return;
		}

		const lowerQuery = query.toLowerCase();
		const matchingItems = new Set<ResourceItem>();
		const matchingSubgroups = new Set<ResourceSubgroup>();
		const matchingGroups = new Set<ResourceGroup>();

		for (const entry of this.flatItems) {
			if (entry.type === "item") {
				const item = entry.item;
				if (
					item.displayName.toLowerCase().includes(lowerQuery) ||
					item.resourceType.toLowerCase().includes(lowerQuery) ||
					item.path.toLowerCase().includes(lowerQuery)
				) {
					matchingItems.add(item);
				}
			}
		}

		// Find which subgroups and groups contain matching items
		for (const group of this.groups) {
			for (const subgroup of group.subgroups) {
				for (const item of subgroup.items) {
					if (matchingItems.has(item)) {
						matchingSubgroups.add(subgroup);
						matchingGroups.add(group);
					}
				}
			}
		}

		this.filteredItems = [];
		for (const entry of this.flatItems) {
			if (entry.type === "group" && matchingGroups.has(entry.group)) {
				this.filteredItems.push(entry);
			} else if (entry.type === "subgroup" && matchingSubgroups.has(entry.subgroup)) {
				this.filteredItems.push(entry);
			} else if (entry.type === "item" && matchingItems.has(entry.item)) {
				this.filteredItems.push(entry);
			}
		}

		this.selectFirstItem();
	}

	private selectFirstItem(): void {
		const firstItemIndex = this.filteredItems.findIndex((e) => e.type === "item");
		this.selectedIndex = firstItemIndex >= 0 ? firstItemIndex : 0;
	}

	updateItem(item: ResourceItem, enabled: boolean): void {
		item.enabled = enabled;
		// Update in groups too
		for (const group of this.groups) {
			for (const subgroup of group.subgroups) {
				const found = subgroup.items.find((i) => i.path === item.path && i.resourceType === item.resourceType);
				if (found) {
					found.enabled = enabled;
					return;
				}
			}
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const showCategories = this.resourceTypes.length > 1;
		const wide = width >= 100 && showCategories;
		const categoryWidth = wide ? 20 : width;
		this.lastWide = wide;
		this.lastCategoryWidth = categoryWidth;
		const bodyWidth = wide ? width - categoryWidth - 3 : width;
		const categoryLine = (index: number): string => {
			const selected = index === this.selectedTypeIndex;
			const label = RESOURCE_TYPE_LABELS[this.resourceTypes[index]!];
			const content = selected
				? `${selectionCursor(true)}${selectedRowLabel(label, true)}${selectionMarkerSuffix(true)}`
				: `${selectionCursor(false)}${theme.fg("muted", label)}`;
			return truncateToWidth(content, categoryWidth);
		};

		if (this.filteredItems.length === 0) {
			lines.push(theme.fg("muted", "  No resources found"));
			if (wide && showCategories) {
				const output = Array.from({ length: this.resourceTypes.length }, (_, index) => {
					const left = index < this.resourceTypes.length ? categoryLine(index) : "";
					return `${left}${" ".repeat(Math.max(0, categoryWidth - visibleWidth(left)))} ${theme.fg("borderMuted", "│")} ${lines[index] ?? ""}`;
				});
				this.lastSearchRow = output.length;
				output.push(...this.searchInput.render(width));
				return output;
			}
			this.lastSearchRow = showCategories ? 1 + lines.length : lines.length;
			return showCategories
				? [
						truncateToWidth(this.resourceTypes.map((_, index) => categoryLine(index)).join(" "), width),
						...lines,
						...this.searchInput.render(width),
					]
				: [...lines, ...this.searchInput.render(width)];
		}

		// Calculate visible range
		const { start: startIndex, end: endIndex } = visibleWindow(
			this.selectedIndex,
			this.filteredItems.length,
			this.maxVisible,
		);
		this.lastVisibleStart = startIndex;
		this.lastVisibleCount = endIndex - startIndex;

		for (let i = startIndex; i < endIndex; i++) {
			const entry = this.filteredItems[i];
			const isSelected = i === this.selectedIndex;

			if (entry.type === "group") {
				// Main group header (no cursor)
				const inherited = this.writeScope === "project" && entry.group.scope === "user";
				const label = theme.bold(`${entry.group.label}${inherited ? " · inherited global" : ""}`);
				const groupLine = theme.fg(inherited ? "dim" : "accent", label);
				lines.push(truncateToWidth(`  ${groupLine}`, bodyWidth, ""));
			} else if (entry.type === "subgroup") {
				// Subgroup header (indented, no cursor)
				const color = this.writeScope === "project" && entry.group.scope === "user" ? "dim" : "muted";
				const subgroupLine = theme.fg(color, entry.subgroup.label);
				lines.push(truncateToWidth(`    ${subgroupLine}`, bodyWidth, ""));
			} else {
				// Resource item (cursor only on items)
				const item = entry.item;
				const cursor = selectionCursor(isSelected);
				const dimmed = this.isDimmedItem(item);
				const nameText =
					isSelected && !dimmed ? theme.bold(theme.fg("accent", item.displayName)) : item.displayName;
				const name = dimmed ? theme.fg("dim", nameText) : nameText;
				const marker = selectionMarkerSuffix(isSelected);
				lines.push(
					truncateToWidth(
						`${cursor}    ${this.renderCheckbox(item)} ${name}${this.getItemSuffix(item)}`,
						bodyWidth - visibleWidth(marker),
						"...",
					) + marker,
				);
			}
		}

		// Scroll indicator
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const itemCount = this.filteredItems.filter((e) => e.type === "item").length;
			const currentItemIndex =
				this.filteredItems.slice(0, this.selectedIndex).filter((e) => e.type === "item").length + 1;
			lines.push(theme.fg("dim", `  (${currentItemIndex}/${itemCount})`));
		}
		const selected = this.filteredItems[this.selectedIndex];
		if (showCategories) lines.push(theme.fg("borderMuted", "─".repeat(bodyWidth)));
		if (selected?.type === "item") {
			const item = selected.item;
			const state =
				this.writeScope === "project"
					? this.resourceConfiguration.getProjectOverrideState(item)
					: item.enabled
						? "load"
						: "unload";
			lines.push(truncateToWidth(theme.fg("muted", `${item.path}`), bodyWidth));
			lines.push(
				truncateToWidth(
					theme.fg("muted", `${item.metadata.scope} · ${item.metadata.origin} · ${state}`),
					bodyWidth,
				),
			);
		}
		if (this.toggleError) lines.push(truncateToWidth(theme.fg("error", this.toggleError), bodyWidth));
		if (wide && showCategories) {
			const rows = Math.max(lines.length, this.resourceTypes.length);
			const combined: string[] = [];
			for (let row = 0; row < rows; row++) {
				const left = row < this.resourceTypes.length ? categoryLine(row) : "";
				combined.push(
					`${left}${" ".repeat(Math.max(0, categoryWidth - visibleWidth(left)))} ${theme.fg("borderMuted", "│")} ${lines[row] ?? ""}`,
				);
			}
			combined.push(...this.searchInput.render(width));
			this.lastSearchRow = combined.length - 1;
			return combined;
		}
		this.lastSearchRow = showCategories ? lines.length + 2 : lines.length;
		return showCategories
			? [
					truncateToWidth(this.resourceTypes.map((_, index) => categoryLine(index)).join(" "), width),
					theme.fg("borderMuted", "─".repeat(width)),
					...lines,
					...this.searchInput.render(width),
				]
			: [...lines, ...this.searchInput.render(width)];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			this.selectedIndex = this.findNextItem(this.selectedIndex, event.wheelDelta < 0 ? -1 : 1);
			this.region = "list";
			this.focused = this._focused;
			return { handled: true, render: true };
		}
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		if (event.y === this.lastSearchRow) {
			this.region = "search";
			this.focused = this._focused;
			return this.searchInput.handleMouse?.({ ...event, y: 0 });
		}
		if (
			this.resourceTypes.length > 1 &&
			this.lastWide &&
			event.x < this.lastCategoryWidth &&
			event.y < this.resourceTypes.length
		) {
			this.selectedTypeIndex = event.y;
			this.region = "categories";
			this.focused = this._focused;
			this.buildFlatList();
			this.filterItems(this.searchInput.getValue());
			return { handled: true, focus: true, render: true };
		}
		const row =
			event.y - (this.lastWide && this.resourceTypes.length > 1 ? 0 : this.resourceTypes.length > 1 ? 2 : 0);
		if (row >= 0 && row < this.lastVisibleCount && (!this.lastWide || event.x > this.lastCategoryWidth + 1)) {
			const index = this.lastVisibleStart + row;
			if (this.filteredItems[index]?.type !== "item") return undefined;
			this.selectedIndex = index;
			this.region = "list";
			this.focused = this._focused;
			if (event.type === "click") void this.toggleSelected();
			return { handled: true, focus: true, render: true };
		}
		return undefined;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.panel.focusNext") || kb.matches(data, "app.panel.focusPrevious")) {
			const regions: readonly ("categories" | "list" | "search")[] =
				this.resourceTypes.length > 1 ? (["categories", "list", "search"] as const) : (["list", "search"] as const);
			const delta = kb.matches(data, "app.panel.focusNext") ? 1 : -1;
			this.region = regions[(regions.indexOf(this.region) + delta + regions.length) % regions.length];
			this.searchInput.focused = this._focused && this.region === "search";
			return;
		}
		if (this.region === "categories" && (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down"))) {
			const delta = kb.matches(data, "tui.select.down") ? 1 : -1;
			this.selectedTypeIndex = moveSelection(this.selectedTypeIndex, this.resourceTypes.length, delta, true);
			this.buildFlatList();
			this.filterItems(this.searchInput.getValue());
			return;
		}
		if (this.region === "categories" && kb.matches(data, "tui.select.confirm")) {
			this.region = "list";
			return;
		}

		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = this.findNextItem(this.selectedIndex, -1, true);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = this.findNextItem(this.selectedIndex, 1, true);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			// Jump up by maxVisible, then find nearest item
			const target = moveSelection(this.selectedIndex, this.filteredItems.length, -this.maxVisible);
			this.selectedIndex = this.findNextItem(target, 1);
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			// Jump down by maxVisible, then find nearest item
			const target = moveSelection(this.selectedIndex, this.filteredItems.length, this.maxVisible);
			this.selectedIndex = this.findNextItem(target, -1);
			return;
		}
		if (kb.matches(data, "app.clear")) {
			this.onExit?.();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}
		if (kb.matches(data, "app.panel.scope")) {
			this.onSwitchMode?.();
			return;
		}
		if (this.region === "list" && data === " ") {
			void this.toggleSelected();
			return;
		}
		if (this.region === "list" && kb.matches(data, "tui.select.confirm")) {
			const entry = this.filteredItems[this.selectedIndex];
			if (entry?.type === "item" && this.onOpen) this.onOpen(entry.item.path);
			else void this.toggleSelected();
			return;
		}

		// Pass to search input
		this.searchInput.handleInput(data);
		this.filterItems(this.searchInput.getValue());
	}

	private async toggleSelected(): Promise<void> {
		const entry = this.filteredItems[this.selectedIndex];
		if (
			this.pendingToggle ||
			entry?.type !== "item" ||
			(this.writeScope !== "project" && this.resourceConfiguration.getItemScope(entry.item) !== "user")
		)
			return;
		this.toggleError = this.beforeToggle?.();
		if (this.toggleError) return;
		this.pendingToggle = true;
		try {
			const newEnabled = await this.resourceConfiguration.toggleResource(entry.item);
			if (newEnabled !== undefined) {
				this.updateItem(entry.item, newEnabled);
				this.onToggle?.(entry.item, newEnabled);
			}
		} catch (error: unknown) {
			this.toggleError = error instanceof Error ? error.message : String(error);
		} finally {
			this.pendingToggle = false;
			this.requestRender();
		}
	}

	private renderCheckbox(item: ResourceItem): string {
		if (this.writeScope === "project") {
			const state = this.resourceConfiguration.getProjectOverrideState(item);
			if (state === "load") return theme.fg("success", "[+]");
			if (state === "unload") return theme.fg("warning", "[-]");
			return checkboxGlyph(item.enabled, false);
		}
		return checkboxGlyph(item.enabled);
	}

	private getItemSuffix(item: ResourceItem): string {
		if (this.writeScope !== "project") return "";
		const state = this.resourceConfiguration.getProjectOverrideState(item);
		if (state === "load") return theme.fg("muted", "  project load");
		if (state === "unload") return theme.fg("muted", "  project unload");
		return this.resourceConfiguration.isInheritedGlobalItem(item) ? theme.fg("dim", "  inherited global") : "";
	}

	private isDimmedItem(item: ResourceItem): boolean {
		return (
			this.writeScope === "project" &&
			this.resourceConfiguration.isInheritedGlobalItem(item) &&
			this.resourceConfiguration.getProjectOverrideState(item) === "inherit"
		);
	}
}

export class ConfigSelectorComponent extends Container implements Focusable {
	private header: ConfigSelectorHeader;
	private resourceList: ResourceList;
	private writeScope: ConfigWriteScope;
	private readonly getAvailableHeight: (() => number) | undefined;
	private availableHeight: number | undefined;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.resourceList.focused = value;
	}

	constructor(
		resolvedPaths: ScopedResolvedPaths,
		settingsManager: SettingsManager,
		cwd: string,
		agentDir: string,
		onClose: () => void,
		onExit: () => void,
		requestRender: () => void,
		terminalHeight?: number,
		writeScope: ConfigWriteScope = "global",
		projectModeAvailable = true,
		getAvailableHeight?: () => number,
		options: ConfigSelectorOptions = {},
	) {
		super();

		this.writeScope = writeScope;
		this.getAvailableHeight = getAvailableHeight;
		const groupsByScope = {
			global: buildGroups(resolvedPaths.global, agentDir),
			project: buildGroups(resolvedPaths.project, agentDir),
		};

		const embedded = options.embedded ?? false;
		if (!embedded) {
			this.addChild(new Spacer(1));
			this.addChild(new DynamicBorder());
			this.addChild(new Spacer(1));
		}
		this.header = new ConfigSelectorHeader(this.writeScope, projectModeAvailable, options.title, embedded);
		this.addChild(this.header);
		if (!embedded) this.addChild(new Spacer(1));

		// Resource list
		this.resourceList = new ResourceList(
			groupsByScope,
			options.resourceConfiguration ??
				new ResourceConfiguration(settingsManager, cwd, agentDir, resolvedPaths.global, writeScope),
			terminalHeight,
			this.writeScope,
			options.resourceTypes,
			embedded,
			requestRender,
		);
		this.resourceList.onCancel = onClose;
		this.resourceList.onExit = onExit;
		this.resourceList.onToggle = () => {
			options.onToggle?.();
		};
		this.resourceList.onOpen = options.onOpen;
		this.resourceList.beforeToggle = options.beforeToggle;
		if (projectModeAvailable) {
			this.resourceList.onSwitchMode = () => {
				this.switchWriteScope();
				requestRender();
			};
		}
		this.addChild(this.resourceList);

		if (!embedded) {
			this.addChild(new Spacer(1));
			this.addChild(new DynamicBorder());
		}
	}

	override render(width: number): string[] {
		const height = this.getAvailableHeight?.();
		if (height !== undefined && height !== this.availableHeight) this.setAvailableHeight(height);
		return super.render(width);
	}

	private switchWriteScope(): void {
		this.writeScope = this.writeScope === "global" ? "project" : "global";
		this.header.setWriteScope(this.writeScope);
		this.resourceList.setWriteScope(this.writeScope);
	}

	setAvailableHeight(height: number): void {
		this.availableHeight = height;
		this.resourceList.setAvailableHeight(height);
	}

	getResourceList(): ResourceList {
		return this.resourceList;
	}

	handleInput(data: string): void {
		this.resourceList.handleInput(data);
	}
}
