import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	moveSelection,
	sliceByColumn,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@candy/tui";
import type { SessionTreeNode } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.ts";
import { type FlatNode, flattenSessionTree, type GutterInfo, type ToolCallInfo } from "./tree-projection.ts";
import { LabelInput, TreeHelp } from "./tree-selector-controls.ts";

interface HorizontalViewportRow {
	gutter: string;
	body: string;
	anchorCol: number;
	bodyWidth: number;
	isSelected: boolean;
}

const TREE_GUTTER_WIDTH = 2;
const MIN_VISIBLE_ANCHOR_CONTENT_WIDTH = 4;
const MAX_VISIBLE_ANCHOR_CONTENT_WIDTH = 20;
const MIN_ANCHOR_CONTEXT_WIDTH = 2;
const MAX_ANCHOR_CONTEXT_WIDTH = 12;

/**
 * Render tree rows into a horizontally clipped viewport.
 *
 * The tree gutter is always kept visible. The row bodies are shifted left only
 * when the selected row's anchor (the start of its entry text after tree
 * indentation/markers) would otherwise be too far right to see useful content.
 */
function renderHorizontalViewport(rows: HorizontalViewportRow[], width: number): string[] {
	const viewportWidth = Math.max(0, width - TREE_GUTTER_WIDTH);
	const maxBodyWidth = rows.reduce((max, row) => Math.max(max, row.bodyWidth), 0);
	const maxHorizontalScroll = Math.max(0, maxBodyWidth - viewportWidth);
	const selectedRow = rows.find((row) => row.isSelected);

	// Only pan horizontally when needed to keep enough selected-row content visible after its anchor.
	let horizontalScroll = 0;
	if (selectedRow && maxHorizontalScroll > 0) {
		const minVisibleAnchorContentWidth = Math.min(
			MAX_VISIBLE_ANCHOR_CONTENT_WIDTH,
			Math.max(MIN_VISIBLE_ANCHOR_CONTENT_WIDTH, Math.floor(viewportWidth / 3)),
		);
		if (selectedRow.anchorCol > viewportWidth - minVisibleAnchorContentWidth) {
			const anchorContextWidth = Math.min(
				MAX_ANCHOR_CONTEXT_WIDTH,
				Math.max(MIN_ANCHOR_CONTEXT_WIDTH, Math.floor(viewportWidth / 4)),
			);
			horizontalScroll = Math.min(maxHorizontalScroll, selectedRow.anchorCol - anchorContextWidth);
		}
	}

	// Clip only the body; the fixed-width gutter remains visible as navigation context.
	return rows.map((row) => {
		const line =
			horizontalScroll > 0
				? `${row.gutter}${sliceByColumn(row.body, horizontalScroll, viewportWidth, true)}\x1b[0m`
				: row.gutter + row.body;
		return truncateToWidth(line, width, "");
	});
}

/** Filter mode for tree display */
export type FilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

/**
 * Tree list component with selection and ASCII art visualization
 */
class TreeList implements Component {
	private flatNodes: FlatNode[] = [];
	private filteredNodes: FlatNode[] = [];
	private selectedIndex = 0;
	private currentLeafId: string | null;
	private maxVisibleLines: number;
	private filterMode: FilterMode = "default";
	private searchQuery = "";
	private toolCallMap: Map<string, ToolCallInfo> = new Map();
	private multipleRoots = false;
	private showLabelTimestamps = false;
	private activePathIds: Set<string> = new Set();
	private visibleParentMap: Map<string, string | null> = new Map();
	private visibleChildrenMap: Map<string | null, string[]> = new Map();
	private lastSelectedId: string | null = null;
	private foldedNodes: Set<string> = new Set();
	private detailOffset = 0;
	private detailLineCount = 0;
	private detailHeight = 5;
	private availableHeight = 20;
	private region: "tree" | "detail" | "search" = "tree";
	private lastVisibleStart = 0;
	private lastVisibleCount = 0;

	public onSelect?: (entryId: string) => void;
	public onCancel?: () => void;
	public onCopy?: (text: string | undefined) => void;
	public onLabelEdit?: (entryId: string, currentLabel: string | undefined) => void;

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		maxVisibleLines: number,
		initialSelectedId?: string,
		initialFilterMode?: FilterMode,
	) {
		this.currentLeafId = currentLeafId;
		this.maxVisibleLines = maxVisibleLines;
		this.filterMode = initialFilterMode ?? "default";
		const projection = flattenSessionTree(tree, currentLeafId);
		this.flatNodes = projection.nodes;
		this.toolCallMap = projection.toolCallMap;
		this.multipleRoots = projection.multipleRoots;
		this.buildActivePath();
		this.applyFilter();

		// Start with initialSelectedId if provided, otherwise current leaf
		const targetId = initialSelectedId ?? currentLeafId;
		this.selectedIndex = this.findNearestVisibleIndex(targetId);
		this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? null;
	}

	/**
	 * Find the index of the nearest visible entry, walking up the parent chain if needed.
	 * Returns the index in filteredNodes, or the last index as fallback.
	 */
	private findNearestVisibleIndex(entryId: string | null): number {
		if (this.filteredNodes.length === 0) return 0;

		// Build a map for parent lookup
		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// Build a map of visible entry IDs to their indices in filteredNodes
		const visibleIdToIndex = new Map<string, number>(this.filteredNodes.map((node, i) => [node.node.entry.id, i]));

		// Walk from entryId up to root, looking for a visible entry
		let currentId = entryId;
		while (currentId !== null) {
			const index = visibleIdToIndex.get(currentId);
			if (index !== undefined) return index;
			const node = entryMap.get(currentId);
			if (!node) break;
			currentId = node.node.entry.parentId ?? null;
		}

		// Fallback: last visible entry
		return this.filteredNodes.length - 1;
	}

	/** Build the set of entry IDs on the path from root to current leaf */
	private buildActivePath(): void {
		this.activePathIds.clear();
		if (!this.currentLeafId) return;

		// Build a map of id -> entry for parent lookup
		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// Walk from leaf to root
		let currentId: string | null = this.currentLeafId;
		while (currentId) {
			this.activePathIds.add(currentId);
			const node = entryMap.get(currentId);
			if (!node) break;
			currentId = node.node.entry.parentId ?? null;
		}
	}

	private applyFilter(): void {
		// Update lastSelectedId only when we have a valid selection (non-empty list)
		// This preserves the selection when switching through empty filter results
		if (this.filteredNodes.length > 0) {
			this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
		}

		const searchTokens = this.searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

		this.filteredNodes = this.flatNodes.filter((flatNode) => {
			const entry = flatNode.node.entry;
			if (entry.type === "usage") return false;
			const isCurrentLeaf = entry.id === this.currentLeafId;

			// Skip assistant messages with only tool calls (no text) unless error/aborted
			// Always show current leaf so active position is visible
			if (entry.type === "message" && entry.message.role === "assistant" && !isCurrentLeaf) {
				const msg = entry.message as { stopReason?: string; content?: unknown };
				const hasText = this.hasTextContent(msg.content);
				const isErrorOrAborted = msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
				// Only hide if no text AND not an error/aborted message
				if (!hasText && !isErrorOrAborted) {
					return false;
				}
			}

			// Apply filter mode
			let passesFilter = true;
			// Entry types hidden in default view (settings/bookkeeping)
			const isSettingsEntry =
				entry.type === "label" ||
				entry.type === "context_edit" ||
				entry.type === "custom" ||
				entry.type === "model_change" ||
				entry.type === "thinking_level_change" ||
				entry.type === "session_info";

			switch (this.filterMode) {
				case "user-only":
					// Just user messages
					passesFilter = entry.type === "message" && entry.message.role === "user";
					break;
				case "no-tools":
					// Default minus tool results
					passesFilter = !isSettingsEntry && !(entry.type === "message" && entry.message.role === "toolResult");
					break;
				case "labeled-only":
					// Just labeled entries
					passesFilter = flatNode.node.label !== undefined;
					break;
				case "all":
					// Show everything
					passesFilter = true;
					break;
				default:
					// Default mode: hide settings/bookkeeping entries
					passesFilter = !isSettingsEntry;
					break;
			}

			if (!passesFilter) return false;

			// Apply search filter
			if (searchTokens.length > 0) {
				const nodeText = this.getSearchableText(flatNode.node).toLowerCase();
				return searchTokens.every((token) => nodeText.includes(token));
			}

			return true;
		});

		// Filter out descendants of folded nodes.
		if (this.foldedNodes.size > 0) {
			const skipSet = new Set<string>();
			for (const flatNode of this.flatNodes) {
				const { id, parentId } = flatNode.node.entry;
				if (parentId != null && (this.foldedNodes.has(parentId) || skipSet.has(parentId))) {
					skipSet.add(id);
				}
			}
			this.filteredNodes = this.filteredNodes.filter((flatNode) => !skipSet.has(flatNode.node.entry.id));
		}

		// Recalculate visual structure (indent, connectors, gutters) based on visible tree
		this.recalculateVisualStructure();

		// Try to preserve cursor on the same node, or find nearest visible ancestor
		if (this.lastSelectedId) {
			this.selectedIndex = this.findNearestVisibleIndex(this.lastSelectedId);
		} else if (this.selectedIndex >= this.filteredNodes.length) {
			// Clamp index if out of bounds
			this.selectedIndex = Math.max(0, this.filteredNodes.length - 1);
		}

		// Update lastSelectedId to the actual selection (may have changed due to parent walk)
		if (this.filteredNodes.length > 0) {
			this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
		}
	}

	/**
	 * Recompute indentation/connectors for the filtered view
	 *
	 * Filtering can hide intermediate entries; descendants attach to the nearest visible ancestor.
	 * Keep indentation semantics aligned with the full-tree projection so single-child chains don't drift right.
	 */
	private recalculateVisualStructure(): void {
		if (this.filteredNodes.length === 0) return;

		const visibleIds = new Set(this.filteredNodes.map((n) => n.node.entry.id));

		// Build entry map for efficient parent lookup (using full tree)
		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// Find nearest visible ancestor for a node
		const findVisibleAncestor = (nodeId: string): string | null => {
			let currentId = entryMap.get(nodeId)?.node.entry.parentId ?? null;
			while (currentId !== null) {
				if (visibleIds.has(currentId)) {
					return currentId;
				}
				currentId = entryMap.get(currentId)?.node.entry.parentId ?? null;
			}
			return null;
		};

		// Build visible tree structure:
		// - visibleParent: nodeId → nearest visible ancestor (or null for roots)
		// - visibleChildren: parentId → list of visible children (in filteredNodes order)
		const visibleParent = new Map<string, string | null>();
		const visibleChildren = new Map<string | null, string[]>();
		visibleChildren.set(null, []); // root-level nodes

		for (const flatNode of this.filteredNodes) {
			const nodeId = flatNode.node.entry.id;
			const ancestorId = findVisibleAncestor(nodeId);
			visibleParent.set(nodeId, ancestorId);

			if (!visibleChildren.has(ancestorId)) {
				visibleChildren.set(ancestorId, []);
			}
			visibleChildren.get(ancestorId)!.push(nodeId);
		}

		// Update multipleRoots based on visible roots
		const visibleRootIds = visibleChildren.get(null)!;
		this.multipleRoots = visibleRootIds.length > 1;

		// Build a map for quick lookup: nodeId → FlatNode
		const filteredNodeMap = new Map<string, FlatNode>();
		for (const flatNode of this.filteredNodes) {
			filteredNodeMap.set(flatNode.node.entry.id, flatNode);
		}

		// DFS over the visible tree using the full-tree projection's indentation semantics
		// Stack items: [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
		type StackItem = [string, number, boolean, boolean, boolean, GutterInfo[], boolean];
		const stack: StackItem[] = [];

		// Add visible roots in reverse order (to process in forward order via stack)
		for (let i = visibleRootIds.length - 1; i >= 0; i--) {
			const isLast = i === visibleRootIds.length - 1;
			stack.push([
				visibleRootIds[i],
				this.multipleRoots ? 1 : 0,
				this.multipleRoots,
				this.multipleRoots,
				isLast,
				[],
				this.multipleRoots,
			]);
		}

		while (stack.length > 0) {
			const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

			const flatNode = filteredNodeMap.get(nodeId);
			if (!flatNode) continue;

			// Update this node's visual properties
			flatNode.indent = indent;
			flatNode.showConnector = showConnector;
			flatNode.isLast = isLast;
			flatNode.gutters = gutters;
			flatNode.isVirtualRootChild = isVirtualRootChild;

			// Get visible children of this node
			const children = visibleChildren.get(nodeId) || [];
			const multipleChildren = children.length > 1;

			// Branch points and their first generation shift the child indentation by one.
			let childIndent: number;
			if (multipleChildren) {
				childIndent = indent + 1;
			} else if (justBranched && indent > 0) {
				childIndent = indent + 1;
			} else {
				childIndent = indent;
			}

			// Child gutters follow the connector and gutter rules from the full-tree projection.
			const connectorDisplayed = showConnector && !isVirtualRootChild;
			const currentDisplayIndent = this.multipleRoots ? Math.max(0, indent - 1) : indent;
			const connectorPosition = Math.max(0, currentDisplayIndent - 1);
			const childGutters: GutterInfo[] = connectorDisplayed
				? [...gutters, { position: connectorPosition, show: !isLast }]
				: gutters;

			// Add children in reverse order (to process in forward order via stack)
			for (let i = children.length - 1; i >= 0; i--) {
				const childIsLast = i === children.length - 1;
				stack.push([
					children[i],
					childIndent,
					multipleChildren,
					multipleChildren,
					childIsLast,
					childGutters,
					false,
				]);
			}
		}

		// Store visible tree maps for ancestor/descendant lookups in navigation
		this.visibleParentMap = visibleParent;
		this.visibleChildrenMap = visibleChildren;
	}

	/** Get searchable text content from a node */
	private getSearchableText(node: SessionTreeNode): string {
		const entry = node.entry;
		const parts: string[] = [];

		if (node.label) {
			parts.push(node.label);
		}

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				parts.push(msg.role);
				if ("content" in msg && msg.content) {
					parts.push(this.extractContent(msg.content));
				}
				if (msg.role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					if (bashMsg.command) parts.push(bashMsg.command);
				}
				break;
			}
			case "custom_message": {
				parts.push(entry.customType);
				if (typeof entry.content === "string") {
					parts.push(entry.content);
				} else {
					parts.push(this.extractContent(entry.content));
				}
				break;
			}
			case "compaction":
				parts.push("compaction");
				break;
			case "branch_summary":
				parts.push("branch summary", entry.summary);
				break;
			case "session_info":
				parts.push("title");
				if (entry.name) parts.push(entry.name);
				break;
			case "model_change":
				parts.push("model", entry.modelId);
				break;
			case "thinking_level_change":
				parts.push("thinking", entry.thinkingLevel);
				break;
			case "custom":
				parts.push("custom", entry.customType);
				break;
			case "context_edit":
				parts.push("context edit", entry.replacement === null ? "omit" : "replace", entry.targetId);
				break;
			case "label":
				parts.push("label", entry.label ?? "");
				break;
		}

		return parts.join(" ");
	}

	invalidate(): void {}

	getSearchQuery(): string {
		return this.searchQuery;
	}

	getSelectedNode(): SessionTreeNode | undefined {
		return this.filteredNodes[this.selectedIndex]?.node;
	}

	setAvailableHeight(height: number): void {
		this.availableHeight = Math.max(6, height);
		this.detailHeight = Math.max(3, Math.min(8, Math.floor(this.availableHeight / 4)));
		this.maxVisibleLines = Math.max(3, this.availableHeight - this.detailHeight - 4);
	}

	copySelected(): void {
		const node = this.getSelectedNode();
		this.onCopy?.(node ? this.getEntryCopyText(node) : undefined);
	}

	updateNodeLabel(entryId: string, label: string | undefined, labelTimestamp?: string): void {
		for (const flatNode of this.flatNodes) {
			if (flatNode.node.entry.id === entryId) {
				flatNode.node.label = label;
				flatNode.node.labelTimestamp = label ? (labelTimestamp ?? new Date().toISOString()) : undefined;
				break;
			}
		}
	}

	private getStatusLabels(): string {
		let labels = "";
		switch (this.filterMode) {
			case "no-tools":
				labels += " [no-tools]";
				break;
			case "user-only":
				labels += " [user]";
				break;
			case "labeled-only":
				labels += " [labeled]";
				break;
			case "all":
				labels += " [all]";
				break;
		}
		if (this.showLabelTimestamps) {
			labels += " [+label time]";
		}
		return labels;
	}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.filteredNodes.length === 0) {
			lines.push(truncateToWidth(theme.fg("muted", "  No entries found"), width));
			while (lines.length < this.maxVisibleLines) lines.push("");
			lines.push(truncateToWidth(theme.fg("muted", `  (0/0)${this.getStatusLabels()}`), width));
			while (lines.length < this.availableHeight) lines.push("");
			return lines;
		}

		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisibleLines / 2),
				this.filteredNodes.length - this.maxVisibleLines,
			),
		);
		const endIndex = Math.min(startIndex + this.maxVisibleLines, this.filteredNodes.length);
		this.lastVisibleStart = startIndex;
		this.lastVisibleCount = endIndex - startIndex;

		const renderedRows: HorizontalViewportRow[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const flatNode = this.filteredNodes[i];
			const entry = flatNode.node.entry;
			const isSelected = i === this.selectedIndex;

			// Build line: cursor + prefix + path marker + label + content
			const cursor = isSelected ? theme.fg("borderAccent", "♦ ") : "  ";

			// If multiple roots, shift display (roots at 0, not 1)
			const displayIndent = this.multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;

			// Build prefix with gutters at their correct positions
			// Each gutter has a position (displayIndent where its connector was shown)
			const connector =
				flatNode.showConnector && !flatNode.isVirtualRootChild ? (flatNode.isLast ? "└─ " : "├─ ") : "";
			const connectorPosition = connector ? displayIndent - 1 : -1;

			// Build prefix char by char, placing gutters and connector at their positions
			const totalChars = displayIndent * 3;
			const prefixChars: string[] = [];
			const isFolded = this.foldedNodes.has(entry.id);
			for (let i = 0; i < totalChars; i++) {
				const level = Math.floor(i / 3);
				const posInLevel = i % 3;

				// Check if there's a gutter at this level
				const gutter = flatNode.gutters.find((g) => g.position === level);
				if (gutter) {
					if (posInLevel === 0) {
						prefixChars.push(gutter.show ? "│" : " ");
					} else {
						prefixChars.push(" ");
					}
				} else if (connector && level === connectorPosition) {
					// Connector at this level, with fold indicator
					if (posInLevel === 0) {
						prefixChars.push(flatNode.isLast ? "└" : "├");
					} else if (posInLevel === 1) {
						const foldable = this.isFoldable(entry.id);
						prefixChars.push(isFolded ? "⊞" : foldable ? "⊟" : "─");
					} else {
						prefixChars.push(" ");
					}
				} else {
					prefixChars.push(" ");
				}
			}
			const prefix = prefixChars.join("");

			// Fold marker for nodes without connectors (roots)
			const showsFoldInConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
			const foldMarker = isFolded && !showsFoldInConnector ? theme.fg("accent", "⊞ ") : "";

			// Active path marker - shown right before the entry text
			const isOnActivePath = this.activePathIds.has(entry.id);
			const pathMarker = isOnActivePath ? theme.fg("accent", "• ") : "";

			const label = flatNode.node.label ? theme.fg("warning", `[${flatNode.node.label}] `) : "";
			const labelTimestamp =
				this.showLabelTimestamps && flatNode.node.label && flatNode.node.labelTimestamp
					? theme.fg("muted", `${this.formatLabelTimestamp(flatNode.node.labelTimestamp)} `)
					: "";
			const content = this.getEntryDisplayText(flatNode.node, isSelected);
			const prefixPart = theme.fg("dim", prefix) + foldMarker + pathMarker;
			const anchorCol = visibleWidth(prefixPart);
			const gutter = cursor;
			let body = prefixPart + label + labelTimestamp + content;
			if (isSelected) body = `${theme.bold(theme.fg("accent", body))}${theme.fg("borderAccent", " ♦")}`;
			renderedRows.push({ gutter, body, anchorCol, bodyWidth: visibleWidth(body), isSelected });
		}

		lines.push(...renderHorizontalViewport(renderedRows, width));
		while (lines.length < this.maxVisibleLines) lines.push("");
		lines.push(
			truncateToWidth(
				theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredNodes.length})${this.getStatusLabels()}`),
				width,
			),
		);
		lines.push(theme.fg("borderMuted", "─".repeat(width)));
		const selected = this.getSelectedNode();
		if (selected) {
			const title = selected.label ?? this.getEntryDisplayText(selected, false);
			lines.push(truncateToWidth(theme.bold(theme.fg("accent", title)), width));
			const fullText = this.getEntryCopyText(selected) ?? this.getSearchableText(selected);
			const detailLines = wrapTextWithAnsi(fullText, Math.max(10, width - 2));
			this.detailLineCount = detailLines.length;
			for (const line of detailLines.slice(this.detailOffset, this.detailOffset + this.detailHeight)) {
				lines.push(truncateToWidth(`  ${line}`, width));
			}
			while (lines.length < this.maxVisibleLines + 3 + this.detailHeight) lines.push("");
			lines.push(
				detailLines.length > this.detailHeight
					? theme.fg(
							"muted",
							`  ${this.detailOffset + 1}–${Math.min(detailLines.length, this.detailOffset + this.detailHeight)} / ${detailLines.length}`,
						)
					: "",
			);
		}

		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			this.selectedIndex = moveSelection(
				this.selectedIndex,
				this.filteredNodes.length,
				event.wheelDelta < 0 ? -1 : 1,
			);
			return { handled: true, render: true };
		}
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		if (event.y >= 0 && event.y < this.lastVisibleCount) {
			this.selectedIndex = this.lastVisibleStart + event.y;
			this.detailOffset = 0;
			this.region = "tree";
			if (event.type === "click") this.onSelect?.(this.filteredNodes[this.selectedIndex]!.node.entry.id);
			return { handled: true, focus: true, render: true };
		}
		return undefined;
	}

	private getEntryDisplayText(node: SessionTreeNode, isSelected: boolean): string {
		const entry = node.entry;
		let result: string;

		const normalize = (s: string) => s.replace(/[\n\t]/g, " ").trim();

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				const role = msg.role;
				if (role === "user") {
					const msgWithContent = msg as { content?: unknown };
					const content = normalize(this.extractContent(msgWithContent.content));
					result = theme.fg("accent", "user: ") + content;
				} else if (role === "assistant") {
					const msgWithContent = msg as { content?: unknown; stopReason?: string; errorMessage?: string };
					const textContent = normalize(this.extractContent(msgWithContent.content));
					if (textContent) {
						result = theme.fg("success", "assistant: ") + textContent;
					} else if (msgWithContent.stopReason === "aborted") {
						result = theme.fg("success", "assistant: ") + theme.fg("muted", "(aborted)");
					} else if (msgWithContent.errorMessage) {
						const errMsg = normalize(msgWithContent.errorMessage).slice(0, 80);
						result = theme.fg("success", "assistant: ") + theme.fg("error", errMsg);
					} else {
						result = theme.fg("success", "assistant: ") + theme.fg("muted", "(no content)");
					}
				} else if (role === "toolResult") {
					const toolMsg = msg as { toolCallId?: string; toolName?: string };
					const toolCall = toolMsg.toolCallId ? this.toolCallMap.get(toolMsg.toolCallId) : undefined;
					if (toolCall) {
						result = theme.fg("muted", this.formatToolCall(toolCall.name, toolCall.arguments));
					} else {
						result = theme.fg("muted", `[${toolMsg.toolName ?? "tool"}]`);
					}
				} else if (role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					result = theme.fg("dim", `[bash]: ${normalize(bashMsg.command ?? "")}`);
				} else {
					result = theme.fg("dim", `[${role}]`);
				}
				break;
			}
			case "custom_message": {
				const content =
					typeof entry.content === "string"
						? entry.content
						: entry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
				result = theme.fg("customMessageLabel", `[${entry.customType}]: `) + normalize(content);
				break;
			}
			case "compaction": {
				const tokens = Math.round(entry.tokensBefore / 1000);
				result = theme.fg("borderAccent", `[compaction: ${tokens}k tokens]`);
				break;
			}
			case "branch_summary":
				result = theme.fg("warning", `[branch summary]: `) + normalize(entry.summary);
				break;
			case "model_change":
				result = theme.fg("dim", `[model: ${entry.modelId}]`);
				break;
			case "thinking_level_change":
				result = theme.fg("dim", `[thinking: ${entry.thinkingLevel}]`);
				break;
			case "custom":
				result = theme.fg("dim", `[custom: ${entry.customType}]`);
				break;
			case "context_edit":
				result = theme.fg("dim", `[context ${entry.replacement === null ? "omit" : "replace"}: ${entry.targetId}]`);
				break;
			case "label":
				result = theme.fg("dim", `[label: ${entry.label ?? "(cleared)"}]`);
				break;
			case "session_info":
				result = entry.name
					? [theme.fg("dim", "[title: "), theme.fg("dim", entry.name), theme.fg("dim", "]")].join("")
					: [theme.fg("dim", "[title: "), theme.italic(theme.fg("dim", "empty")), theme.fg("dim", "]")].join("");
				break;
			default:
				result = "";
		}

		return isSelected ? theme.bold(result) : result;
	}

	private formatLabelTimestamp(timestamp: string): string {
		const date = new Date(timestamp);
		const now = new Date();
		const hours = date.getHours().toString().padStart(2, "0");
		const minutes = date.getMinutes().toString().padStart(2, "0");
		const time = `${hours}:${minutes}`;

		if (
			date.getFullYear() === now.getFullYear() &&
			date.getMonth() === now.getMonth() &&
			date.getDate() === now.getDate()
		) {
			return time;
		}

		const month = date.getMonth() + 1;
		const day = date.getDate();
		if (date.getFullYear() === now.getFullYear()) {
			return `${month}/${day} ${time}`;
		}

		const year = date.getFullYear().toString().slice(-2);
		return `${year}/${month}/${day} ${time}`;
	}

	private extractContent(content: unknown): string {
		return this.extractFullContent(content).slice(0, 200);
	}

	private extractFullContent(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";

		let result = "";
		for (const block of content) {
			if (typeof block === "object" && block !== null && "type" in block && block.type === "text") {
				result += (block as { text: string }).text;
			}
		}
		return result;
	}

	private getEntryCopyText(node: SessionTreeNode): string | undefined {
		const entry = node.entry;
		let text: string | undefined;

		switch (entry.type) {
			case "message":
				if (entry.message.role === "bashExecution") {
					text = entry.message.command;
				} else if ("content" in entry.message) {
					text = this.extractFullContent(entry.message.content);
					if (!text && entry.message.role === "assistant") {
						text = entry.message.errorMessage;
					}
				}
				break;
			case "custom_message":
				text = this.extractFullContent(entry.content);
				break;
			case "compaction":
				text = entry.summary;
				break;
			case "branch_summary":
				text = entry.summary;
				break;
		}

		return text?.trim() ? text : undefined;
	}

	private hasTextContent(content: unknown): boolean {
		if (typeof content === "string") return content.trim().length > 0;
		if (Array.isArray(content)) {
			for (const c of content) {
				if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
					const text = (c as { text?: string }).text;
					if (text && text.trim().length > 0) return true;
				}
			}
		}
		return false;
	}

	private formatToolCall(name: string, args: Record<string, unknown>): string {
		const shortenPath = (p: string): string => {
			const home = process.env.HOME || process.env.USERPROFILE || "";
			if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
			return p;
		};

		switch (name) {
			case "read": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				const offset = args.offset as number | undefined;
				const limit = args.limit as number | undefined;
				let display = path;
				if (offset !== undefined || limit !== undefined) {
					const start = offset ?? 1;
					const end = limit !== undefined ? start + limit - 1 : "";
					display += `:${start}${end ? `-${end}` : ""}`;
				}
				return `[read: ${display}]`;
			}
			case "write": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				return `[write: ${path}]`;
			}
			case "edit": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				return `[edit: ${path}]`;
			}
			case "bash": {
				const rawCmd = String(args.command || "");
				const cmd = rawCmd
					.replace(/[\n\t]/g, " ")
					.trim()
					.slice(0, 50);
				return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
			}
			case "grep": {
				const pattern = String(args.pattern || "");
				const path = shortenPath(String(args.path || "."));
				return `[grep: /${pattern}/ in ${path}]`;
			}
			case "find": {
				const pattern = String(args.pattern || "");
				const path = shortenPath(String(args.path || "."));
				return `[find: ${pattern} in ${path}]`;
			}
			case "ls": {
				const path = shortenPath(String(args.path || "."));
				return `[ls: ${path}]`;
			}
			default: {
				// Custom tool - show name and truncated JSON args
				const argsStr = JSON.stringify(args).slice(0, 40);
				return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? "..." : ""}]`;
			}
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.panel.focusNext") || kb.matches(keyData, "app.panel.focusPrevious")) {
			const regions = ["tree", "detail", "search"] as const;
			const delta = kb.matches(keyData, "app.panel.focusNext") ? 1 : -1;
			this.region = regions[(regions.indexOf(this.region) + delta + regions.length) % regions.length];
		} else if (this.region === "detail" && kb.matches(keyData, "tui.select.up")) {
			this.detailOffset = Math.max(0, this.detailOffset - 1);
		} else if (this.region === "detail" && kb.matches(keyData, "tui.select.down")) {
			this.detailOffset = Math.min(Math.max(0, this.detailLineCount - this.detailHeight), this.detailOffset + 1);
		} else if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredNodes.length - 1 : this.selectedIndex - 1;
			this.detailOffset = 0;
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.filteredNodes.length - 1 ? 0 : this.selectedIndex + 1;
			this.detailOffset = 0;
		} else if (kb.matches(keyData, "app.tree.foldOrUp")) {
			const currentId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
			if (currentId && this.isFoldable(currentId) && !this.foldedNodes.has(currentId)) {
				this.foldedNodes.add(currentId);
				this.applyFilter();
			} else {
				this.selectedIndex = this.findBranchSegmentStart("up");
			}
		} else if (kb.matches(keyData, "app.tree.unfoldOrDown")) {
			const currentId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
			if (currentId && this.foldedNodes.has(currentId)) {
				this.foldedNodes.delete(currentId);
				this.applyFilter();
			} else {
				this.selectedIndex = this.findBranchSegmentStart("down");
			}
		} else if (kb.matches(keyData, "tui.editor.cursorLeft") || kb.matches(keyData, "tui.select.pageUp")) {
			// Page up
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisibleLines);
		} else if (kb.matches(keyData, "tui.editor.cursorRight") || kb.matches(keyData, "tui.select.pageDown")) {
			// Page down
			this.selectedIndex = Math.min(this.filteredNodes.length - 1, this.selectedIndex + this.maxVisibleLines);
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredNodes[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.node.entry.id);
			}
		} else if (kb.matches(keyData, "app.message.copy")) {
			this.copySelected();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.searchQuery) {
				this.searchQuery = "";
				this.foldedNodes.clear();
				this.applyFilter();
			} else {
				this.onCancel?.();
			}
		} else if (kb.matches(keyData, "app.tree.filter.default")) {
			// Direct filter: default
			this.filterMode = "default";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.noTools")) {
			// Toggle filter: no-tools ↔ default
			this.filterMode = this.filterMode === "no-tools" ? "default" : "no-tools";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.userOnly")) {
			// Toggle filter: user-only ↔ default
			this.filterMode = this.filterMode === "user-only" ? "default" : "user-only";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.labeledOnly")) {
			// Toggle filter: labeled-only ↔ default
			this.filterMode = this.filterMode === "labeled-only" ? "default" : "labeled-only";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.all")) {
			// Toggle filter: all ↔ default
			this.filterMode = this.filterMode === "all" ? "default" : "all";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.cycleBackward")) {
			// Cycle filter backwards
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			const currentIndex = modes.indexOf(this.filterMode);
			this.filterMode = modes[(currentIndex - 1 + modes.length) % modes.length];
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.cycleForward")) {
			// Cycle filter forwards: default → no-tools → user-only → labeled-only → all → default
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			const currentIndex = modes.indexOf(this.filterMode);
			this.filterMode = modes[(currentIndex + 1) % modes.length];
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "tui.editor.deleteCharBackward")) {
			if (this.searchQuery.length > 0) {
				this.searchQuery = this.searchQuery.slice(0, -1);
				this.foldedNodes.clear();
				this.applyFilter();
			}
		} else if (kb.matches(keyData, "app.tree.editLabel")) {
			const selected = this.filteredNodes[this.selectedIndex];
			if (selected && this.onLabelEdit) {
				this.onLabelEdit(selected.node.entry.id, selected.node.label);
			}
		} else if (kb.matches(keyData, "app.tree.toggleLabelTimestamp")) {
			this.showLabelTimestamps = !this.showLabelTimestamps;
		} else {
			const hasControlChars = [...keyData].some((ch) => {
				const code = ch.charCodeAt(0);
				return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
			});
			if (!hasControlChars && keyData.length > 0) {
				this.searchQuery += keyData;
				this.foldedNodes.clear();
				this.applyFilter();
			}
		}
	}

	/**
	 * Whether a node can be folded. A node is foldable if it has visible children
	 * and is either a root (no visible parent) or a segment start (visible parent
	 * has multiple visible children).
	 */
	private isFoldable(entryId: string): boolean {
		const children = this.visibleChildrenMap.get(entryId);
		if (!children || children.length === 0) return false;
		const parentId = this.visibleParentMap.get(entryId);
		if (parentId === null || parentId === undefined) return true;
		const siblings = this.visibleChildrenMap.get(parentId);
		return siblings !== undefined && siblings.length > 1;
	}

	/**
	 * Find the index of the next branch segment start in the given direction.
	 * A segment start is the first child of a branch point.
	 *
	 * "up" walks the visible parent chain; "down" walks visible children
	 * (always following the first child).
	 */
	private findBranchSegmentStart(direction: "up" | "down"): number {
		const selectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
		if (!selectedId) return this.selectedIndex;

		const indexByEntryId = new Map(this.filteredNodes.map((node, i) => [node.node.entry.id, i]));
		let currentId: string = selectedId;
		if (direction === "down") {
			while (true) {
				const children: string[] = this.visibleChildrenMap.get(currentId) ?? [];
				if (children.length === 0) return indexByEntryId.get(currentId)!;
				if (children.length > 1) return indexByEntryId.get(children[0])!;
				currentId = children[0];
			}
		}

		// direction === "up"
		while (true) {
			const parentId: string | null = this.visibleParentMap.get(currentId) ?? null;
			if (parentId === null) return indexByEntryId.get(currentId)!;
			const children = this.visibleChildrenMap.get(parentId) ?? [];
			if (children.length > 1) {
				const segmentStart = indexByEntryId.get(currentId)!;
				if (segmentStart < this.selectedIndex) {
					return segmentStart;
				}
			}
			currentId = parentId;
		}
	}
}

/** Component that displays the current search query */
class SearchLine implements Component {
	private treeList: TreeList;

	constructor(treeList: TreeList) {
		this.treeList = treeList;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const query = this.treeList.getSearchQuery();
		if (query) {
			return [truncateToWidth(`  ${theme.fg("muted", "Type to search:")} ${theme.fg("accent", query)}`, width)];
		}
		return [truncateToWidth(`  ${theme.fg("muted", "Type to search:")}`, width)];
	}

	handleInput(_keyData: string): void {}
}

/**
 * Component that renders a session tree selector for navigation
 */
export class TreeSelectorComponent extends Container implements Focusable {
	private treeList: TreeList;
	private labelInput: LabelInput | null = null;
	private labelInputContainer: Container;
	private treeContainer: Container;
	private readonly treeHelp = new TreeHelp();
	private availableHeight = 20;
	private onLabelChangeCallback?: (entryId: string, label: string | undefined) => void;
	public onCopy?: (text: string | undefined) => void;

	// Focusable implementation - propagate to labelInput when active for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		// Propagate to labelInput when it's active
		if (this.labelInput) {
			this.labelInput.focused = value;
		}
	}

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		terminalHeight: number,
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		onLabelChange?: (entryId: string, label: string | undefined) => void,
		initialSelectedId?: string,
		initialFilterMode?: FilterMode,
	) {
		super();

		this.onLabelChangeCallback = onLabelChange;
		const maxVisibleLines = Math.max(5, Math.floor(terminalHeight / 2));

		this.treeList = new TreeList(tree, currentLeafId, maxVisibleLines, initialSelectedId, initialFilterMode);
		this.treeList.onSelect = onSelect;
		this.treeList.onCancel = onCancel;
		this.treeList.onCopy = (text) => this.onCopy?.(text);
		this.treeList.onLabelEdit = (entryId, currentLabel) => this.showLabelInput(entryId, currentLabel);

		this.treeContainer = new Container();
		this.treeContainer.addChild(this.treeList);

		this.labelInputContainer = new Container();

		this.addChild(new Text(theme.bold(theme.fg("accent", "Session Tree")), 1, 0));
		this.addChild(this.treeContainer);
		this.addChild(this.labelInputContainer);
		this.addChild(new SearchLine(this.treeList));
		this.addChild(this.treeHelp);

		if (tree.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	setAvailableHeight(height: number): void {
		this.availableHeight = Math.max(8, height);
	}

	override render(width: number): string[] {
		this.treeList.setAvailableHeight(this.availableHeight - this.treeHelp.render(width).length - 2);
		return super.render(width);
	}

	private showLabelInput(entryId: string, currentLabel: string | undefined): void {
		this.labelInput = new LabelInput(entryId, currentLabel);
		this.labelInput.onSubmit = (id, label) => {
			this.treeList.updateNodeLabel(id, label);
			this.onLabelChangeCallback?.(id, label);
			this.hideLabelInput();
		};
		this.labelInput.onCancel = () => this.hideLabelInput();

		// Propagate current focused state to the new labelInput
		this.labelInput.focused = this._focused;

		this.treeContainer.clear();
		this.labelInputContainer.clear();
		this.labelInputContainer.addChild(this.labelInput);
	}

	private hideLabelInput(): void {
		this.labelInput = null;
		this.labelInputContainer.clear();
		this.treeContainer.clear();
		this.treeContainer.addChild(this.treeList);
	}

	handleInput(keyData: string): void {
		if (this.labelInput) {
			this.labelInput.handleInput(keyData);
		} else {
			this.treeList.handleInput(keyData);
		}
	}

	getTreeList(): TreeList {
		return this.treeList;
	}
}
