import type { ThinkingLevel } from "@candy/agent-core";
import type { Model } from "@candy/ai/compat";
import { fuzzyFilter, sliceByColumn, visibleWidth } from "@candy/tui";
import { getModelSelectorSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";

/**
 * Slot separator. Each item owns `labelWidth + SLOT_SEPARATOR` columns and the
 * highlighted item renders `‹ label ›` inside its slot, so moving the
 * highlight never shifts neighboring text.
 */
const SLOT_SEPARATOR = "    ";
const SEP = visibleWidth(SLOT_SEPARATOR);

/** Cursor shown after the search query. */
const SEARCH_CURSOR = "▌";

/** Label introducing the search query. */
const SEARCH_PREFIX = "Model › ";

/** Frames each entering/exiting item animates for. */
const ITEM_FRAMES = 2;

/** Items whose entry is staggered apart; later ones start together. */
const MAX_EXPAND_STAGGER = 3;
const MAX_COLLAPSE_STAGGER = 2;

/** Milliseconds between expand/collapse frames. */
const WIPE_INTERVAL_MS = 30;

/** Frames of a window slide, plus one settling tick. */
const SLIDE_FRAMES = 3;
const SLIDE_INTERVAL_MS = 30;

/** Milliseconds between morph frames (browse -> search and back). */
const MORPH_INTERVAL_MS = 40;

/** Columns reserved for a `‹ ` or ` ›` window edge indicator. */
const INDICATOR_WIDTH = 2;

export type PowerbarModelRef = Model<any>;

/** One selectable entry of the model track. */
export interface PowerbarModelEntry {
	readonly model: PowerbarModelRef;
	/** Display label without provider prefix. */
	readonly label: string;
}

/** Dependencies the powerbar needs from the host application. */
export interface PowerbarHost {
	/** Request a TUI repaint (called once per animation frame). */
	requestRender(): void;
	/** Thinking levels supported by the current model, in display order. */
	getThinkingLevels(): ThinkingLevel[];
	/** Currently active thinking level. */
	getThinkingLevel(): ThinkingLevel;
	/** Models available for switching, in cycle order. */
	getModels(): readonly PowerbarModelEntry[];
	/** Index of the current model in `getModels()`. */
	getCurrentModelIndex(): number;
	/** Apply a thinking level selection. Throws on failure. */
	applyThinking(level: ThinkingLevel, persist: boolean): void;
	/** Apply a model selection. Errors are reported by the host. */
	applyModel(model: PowerbarModelRef): void;
}

type PowerbarMode = "normal" | "thinking" | "model-browse" | "model-search";

interface TrackItem {
	readonly kind: "level" | "model";
	readonly level?: ThinkingLevel;
	readonly model?: PowerbarModelEntry;
	readonly label: string;
	readonly width: number;
}

/** A clickable range relative to the content area (after the frame corner). */
export interface PowerbarRegion {
	readonly start: number;
	readonly width: number;
	readonly itemIndex: number;
}

/** Non-interactive label rendered before the track (the model label while selecting thinking). */
export interface PowerbarPrefixSpan {
	readonly text: string;
	readonly width: number;
}

/** One rendered element: the prefix (index -1) or a track item. */
interface LayoutSpan {
	readonly index: number;
	readonly label: string;
	readonly selected: boolean;
	readonly col: number;
	readonly width: number;
	readonly sliceStart: number;
}

interface WipeEntry {
	readonly index: number;
	readonly label: string;
	readonly selected: boolean;
	readonly wFrom: number;
	readonly wTo: number;
	readonly start: number;
}

interface SlideEntry {
	readonly index: number;
	readonly label: string;
	readonly selected: boolean;
	readonly colFrom: number;
	readonly colTo: number;
	readonly width: number;
}

type Transition =
	| {
			kind: "wipe";
			intervalMs: number;
			frames: number;
			tick: number;
			entries: WipeEntry[];
			onComplete?: () => void;
	  }
	| { kind: "slide"; intervalMs: number; frames: number; tick: number; entries: SlideEntry[] };

function easeOutCubic(p: number): number {
	const t = Math.min(1, Math.max(0, p));
	return 1 - (1 - t) * (1 - t) * (1 - t);
}

function clampIndex(value: number, size: number): number {
	if (size === 0) return 0;
	return Math.min(Math.max(0, value), size - 1);
}

/**
 * Inline selector living in the editor's bottom border ("Powerbar").
 *
 * The track is a row of fixed-size slots laid out cumulatively from the left.
 * Opening, collapsing, and filtering animate each slot's width over discrete
 * frames with ease-out: pushed items glide to their new columns while entering
 * items are revealed underneath them, and the context meter is squeezed out
 * frame by frame. Selecting collapses the track back around the new value.
 * The track is windowed: moving past the visible edge slides the window by one
 * item (animated) so the highlight is always on screen, with dim `‹`/`›`
 * markers when more items exist on either side. A new interaction snaps the
 * running animation and starts from the current visual state instead of
 * queueing behind it.
 */
export class PowerbarController {
	mode: PowerbarMode = "normal";

	private readonly host: PowerbarHost;
	private items: TrackItem[] = [];
	/** Index of the anchor item (the current value at open time). */
	private anchorIndex = 0;
	/** Highlighted item, moved with left/right and confirmed with enter. */
	private selectedIndex = 0;
	/** Inclusive window of items rendered when the track overflows the width. */
	private windowStart = 0;
	private windowEnd = -1;
	private leftIndicator = false;
	private rightIndicator = false;
	/** Model label kept in front of the thinking track. */
	private modelPrefix: PowerbarPrefixSpan | undefined;
	private searchPrefixWidth = 0;
	private query = "";
	/** True while a collapse animation runs; interactions are ignored. */
	private collapsing = false;
	private transition: Transition | undefined;
	private timer: NodeJS.Timeout | undefined;
	private lastMaxWidth = 80;
	private lastRegions: PowerbarRegion[] = [];

	constructor(host: PowerbarHost) {
		this.host = host;
	}

	isIdle(): boolean {
		return this.mode === "normal";
	}

	dispose(): void {
		this.stopTimer();
		this.mode = "normal";
		this.transition = undefined;
	}

	// =========================================================================
	// Opening / closing
	// =========================================================================

	/** Expand the thinking level track out of the effort label. */
	openThinking(options: { anchorWidth: number; prefix: PowerbarPrefixSpan }): void {
		this.stopTimer();
		this.collapsing = false;
		this.mode = "thinking";
		this.modelPrefix = options.prefix;
		this.leftIndicator = false;
		this.rightIndicator = false;
		const levels = this.host.getThinkingLevels();
		const current = this.host.getThinkingLevel();
		this.items = levels.map((level) => {
			const label = level.charAt(0).toUpperCase() + level.slice(1);
			return { kind: "level" as const, level, label, width: visibleWidth(label) };
		});
		this.anchorIndex = clampIndex(levels.indexOf(current), this.items.length);
		this.selectedIndex = this.anchorIndex;
		this.query = "";
		this.searchPrefixWidth = 0;
		this.buildOpenWipe(options.anchorWidth);
		this.host.requestRender();
	}

	/** Expand the model track out of the model label. */
	openModelBrowse(options: { anchorWidth: number }): void {
		this.stopTimer();
		this.collapsing = false;
		this.mode = "model-browse";
		this.modelPrefix = undefined;
		this.leftIndicator = false;
		this.rightIndicator = false;
		this.items = this.host.getModels().map((entry) => ({
			kind: "model" as const,
			model: entry,
			label: entry.label,
			width: visibleWidth(entry.label),
		}));
		this.anchorIndex = clampIndex(this.host.getCurrentModelIndex(), this.items.length);
		this.selectedIndex = this.anchorIndex;
		this.query = "";
		this.searchPrefixWidth = 0;
		this.buildOpenWipe(options.anchorWidth);
		this.host.requestRender();
	}

	/** Collapse back to the normal labels around the current selection. */
	collapse(): void {
		if (this.mode === "normal" || this.collapsing) return;
		this.snapTransition();
		this.selectedIndex = clampIndex(this.anchorIndex, this.items.length);
		this.buildCollapseWipe();
		this.host.requestRender();
	}

	private buildOpenWipe(anchorWidth: number): void {
		const prefix = this.currentPrefixSpan();
		const entries: WipeEntry[] = [
			{ index: -1, label: prefix.text, selected: false, wFrom: prefix.width, wTo: prefix.width, start: 0 },
		];
		this.fitWindow(this.anchorIndex, this.trackMaxWidth());
		const order = this.revealOrderFrom(this.anchorIndex).filter((idx) => this.inWindow(idx));
		order.forEach((idx, j) => {
			const entering = idx !== this.anchorIndex;
			entries.push({
				index: idx,
				label: this.slotText(idx),
				selected: idx === this.selectedIndex,
				wFrom: entering ? 0 : Math.min(anchorWidth, this.slotWidth(idx)),
				wTo: this.slotWidth(idx),
				start: Math.min(j, MAX_EXPAND_STAGGER),
			});
		});
		this.startWipe(entries, WIPE_INTERVAL_MS);
	}

	private buildCollapseWipe(): void {
		const spans = this.computeLayout(this.lastMaxWidth);
		const itemSpans = spans.filter((s) => s.index >= 0);
		const prefixSpan = spans.find((s) => s.index === -1);
		const prefix = this.currentPrefixSpan();

		const entries: WipeEntry[] = [
			{
				index: -1,
				label: prefix.text,
				selected: false,
				wFrom: prefixSpan?.width ?? prefix.width,
				wTo: this.mode === "thinking" ? prefix.width : 0,
				start: 0,
			},
		];

		// Farthest items from the selection exit first; the selection exits last.
		const exitOrder = [...itemSpans].sort(
			(a, b) => Math.abs(b.index - this.selectedIndex) - Math.abs(a.index - this.selectedIndex),
		);
		const startOf = new Map<number, number>();
		exitOrder.forEach((span, k) => {
			startOf.set(span.index, Math.min(k, MAX_COLLAPSE_STAGGER));
		});

		for (const span of [...itemSpans].sort((a, b) => a.index - b.index)) {
			const selected = span.index === this.selectedIndex;
			entries.push({
				index: span.index,
				label: span.label,
				selected,
				wFrom: span.width,
				wTo: selected ? this.slotWidth(span.index) : 0,
				start: startOf.get(span.index) ?? 0,
			});
		}
		this.collapsing = true;
		this.startWipe(entries, WIPE_INTERVAL_MS, () => {
			this.collapsing = false;
			this.mode = "normal";
			this.items = [];
			this.query = "";
			this.searchPrefixWidth = 0;
			this.modelPrefix = undefined;
			this.host.requestRender();
		});
	}

	// =========================================================================
	// Navigation and selection
	// =========================================================================

	/** Move the highlight; slides the window when the selection leaves it. */
	move(delta: number): void {
		if (this.mode === "normal" || this.collapsing) return;
		const next = clampIndex(this.selectedIndex + delta, this.items.length);
		if (next === this.selectedIndex) return;
		this.selectedIndex = next;
		if (next > this.windowEnd) {
			this.slideWindow(1);
		} else if (next < this.windowStart) {
			this.slideWindow(-1);
		}
		this.host.requestRender();
	}

	/** Confirm the highlighted item and collapse around it. */
	confirm(persist = false): void {
		if (this.mode === "normal" || this.collapsing) return;
		const item = this.items[this.selectedIndex];
		if (!item) {
			this.collapse();
			return;
		}
		this.snapTransition();
		if (item.kind === "level" && item.level !== undefined) {
			try {
				this.host.applyThinking(item.level, persist);
			} catch {
				// The host reports the failure; still collapse back to a sane state.
			}
		} else if (item.kind === "model" && item.model !== undefined) {
			this.host.applyModel(item.model.model);
		}
		this.buildCollapseWipe();
		this.host.requestRender();
	}

	// =========================================================================
	// Search input
	// =========================================================================

	/** Feed a printable character; the first one morphs browse into search. */
	inputChar(char: string): void {
		if ((this.mode !== "model-browse" && this.mode !== "model-search") || this.collapsing) return;
		this.query += char;
		if (this.mode === "model-search") {
			this.applyQueryInstant();
		} else {
			this.morphToSearch();
		}
	}

	/** Delete the last query character; emptying it morphs back to browse. */
	backspace(): void {
		if (this.mode !== "model-search" || this.collapsing) return;
		this.query = this.query.slice(0, -1);
		if (this.query.length === 0) {
			this.morphToBrowse();
		} else {
			this.applyQueryInstant();
		}
	}

	private applyQueryInstant(): void {
		this.snapTransition();
		this.searchPrefixWidth = this.computeSearchPrefixWidth();
		this.items = this.filteredModels().map((entry) => ({
			kind: "model" as const,
			model: entry,
			label: entry.label,
			width: visibleWidth(entry.label),
		}));
		this.selectedIndex = clampIndex(this.selectedIndex, this.items.length);
		this.anchorIndex = 0;
		this.fitWindow(this.selectedIndex, this.trackMaxWidth());
		this.host.requestRender();
	}

	private filteredModels(): PowerbarModelEntry[] {
		const query = this.query.trim();
		if (!query) return [...this.host.getModels()];
		return fuzzyFilter([...this.host.getModels()], query, (entry) => getModelSelectorSearchText(entry.model));
	}

	private makeModelItems(entries: readonly PowerbarModelEntry[]): TrackItem[] {
		return entries.map((entry) => ({
			kind: "model" as const,
			model: entry,
			label: entry.label,
			width: visibleWidth(entry.label),
		}));
	}

	/**
	 * Morph from the browse track into the search results. Phase 1 erodes the
	 * non-matching items (sliding the matches left); phase 2 grows the query
	 * prefix in and reveals the result track after it.
	 */
	private morphToSearch(): void {
		this.snapTransition();
		const oldSpans = this.computeLayout(this.lastMaxWidth).filter((s) => s.index >= 0);
		const oldItems = this.items;
		const results = this.filteredModels();

		// Phase 1: erode non-matching items; matching ones keep their slots.
		const erodeEntries: WipeEntry[] = oldSpans.map((span, k) => {
			const kept = results.some((r) => r === oldItems[span.index]?.model);
			return {
				index: k,
				label: span.label,
				selected: span.selected,
				wFrom: span.width,
				wTo: kept ? span.width : 0,
				start: 0,
			};
		});
		this.mode = "model-search";
		this.startWipe(erodeEntries, MORPH_INTERVAL_MS, () => {
			// Phase 2: grow the query prefix and reveal the result track.
			this.items = this.makeModelItems(results);
			this.selectedIndex = 0;
			this.anchorIndex = 0;
			this.searchPrefixWidth = this.computeSearchPrefixWidth();
			this.fitWindow(0, this.trackMaxWidth());
			const prefix = this.currentPrefixSpan();
			const entries: WipeEntry[] = [
				{ index: -1, label: prefix.text, selected: false, wFrom: 0, wTo: prefix.width, start: 0 },
			];
			for (let idx = this.windowStart; idx <= this.windowEnd; idx++) {
				const item = this.items[idx];
				if (!item) continue;
				const kept = oldItems.findIndex((old) => old.model === item.model);
				entries.push({
					index: idx,
					label: this.slotText(idx),
					selected: idx === this.selectedIndex,
					wFrom: kept !== -1 ? (oldSpans.find((s) => s.index === kept)?.width ?? 0) : 0,
					wTo: this.slotWidth(idx),
					start: Math.min(idx - this.windowStart, MAX_EXPAND_STAGGER),
				});
			}
			this.startWipe(entries, MORPH_INTERVAL_MS);
		});
		this.host.requestRender();
	}

	/**
	 * Morph from the search results back to the browse track: the query prefix
	 * erodes while the full track wipes back in around the current model.
	 */
	private morphToBrowse(): void {
		this.snapTransition();
		const oldSpans = this.computeLayout(this.lastMaxWidth);
		const oldItems = this.items;
		const oldPrefixWidth = oldSpans.find((s) => s.index === -1)?.width ?? this.searchPrefixWidth;

		this.mode = "model-browse";
		this.query = "";
		this.searchPrefixWidth = 0;
		this.items = this.makeModelItems(this.host.getModels());
		this.anchorIndex = clampIndex(this.host.getCurrentModelIndex(), this.items.length);
		this.selectedIndex = this.anchorIndex;
		this.leftIndicator = false;
		this.rightIndicator = false;
		this.fitWindow(this.anchorIndex, this.trackMaxWidth());

		const entries: WipeEntry[] = [{ index: -1, label: "", selected: false, wFrom: oldPrefixWidth, wTo: 0, start: 0 }];
		for (let idx = this.windowStart; idx <= this.windowEnd; idx++) {
			const item = this.items[idx]!;
			const previous = oldItems.findIndex((old) => old.model === item.model);
			entries.push({
				index: idx,
				label: this.slotText(idx),
				selected: idx === this.selectedIndex,
				wFrom: previous !== -1 ? (oldSpans.find((s) => s.index === previous)?.width ?? 0) : 0,
				wTo: this.slotWidth(idx),
				start: Math.min(Math.abs(idx - this.anchorIndex), MAX_EXPAND_STAGGER),
			});
		}
		this.startWipe(entries, MORPH_INTERVAL_MS);
		this.host.requestRender();
	}

	// =========================================================================
	// Window sliding
	// =========================================================================

	private slideWindow(direction: 1 | -1): void {
		this.snapTransition();
		const oldStart = this.windowStart;
		const oldEnd = this.windowEnd;
		const newStart = oldStart + direction;
		const newEnd = oldEnd + direction;
		if (newStart < 0 || newEnd > this.items.length - 1) return;

		const outgoing = direction === 1 ? oldStart : oldEnd;
		const shift = (this.slotWidth(outgoing) + SEP) * (direction === 1 ? 1 : -1);
		const oldLeft = this.trackLeft();
		this.windowStart = newStart;
		this.windowEnd = newEnd;
		this.leftIndicator = newStart > 0;
		this.rightIndicator = newEnd < this.items.length - 1;
		const newLeft = this.trackLeft();

		const entries: SlideEntry[] = [];
		for (let idx = Math.min(oldStart, newStart); idx <= Math.max(oldEnd, newEnd); idx++) {
			const inOld = idx >= oldStart && idx <= oldEnd;
			let colFrom: number;
			let colTo: number;
			if (inOld) {
				colFrom = this.cumulativeCol(idx, oldStart, oldLeft);
				colTo = colFrom - shift;
			} else {
				colTo = this.cumulativeCol(idx, newStart, newLeft);
				colFrom = colTo + shift;
			}
			entries.push({
				index: idx,
				label: this.slotText(idx),
				selected: idx === this.selectedIndex,
				colFrom,
				colTo,
				width: this.slotWidth(idx),
			});
		}
		this.transition = {
			kind: "slide",
			intervalMs: SLIDE_INTERVAL_MS,
			frames: SLIDE_FRAMES + 1,
			tick: 0,
			entries,
		};
		this.startTimer();
	}

	/** Column of `index` when the window starts at `start` (slots packed from `left`). */
	private cumulativeCol(index: number, start: number, left: number): number {
		const prefixWidth = this.currentPrefixSpan().width;
		let col = left + (prefixWidth > 0 ? prefixWidth + SEP : 0);
		for (let i = start; i < index; i++) col += this.slotWidth(i) + SEP;
		return col;
	}

	// =========================================================================
	// Layout and rendering
	// =========================================================================

	private slotWidth(index: number): number {
		return (this.items[index]?.width ?? 0) + 4;
	}

	/** Rendered text for an item's slot: label centered, or `‹ label ›` when highlighted. */
	private slotText(index: number): string {
		const item = this.items[index];
		if (!item) return "";
		if (index === this.selectedIndex) {
			return theme.bold(theme.fg("accent", `‹ ${item.label} ›`));
		}
		return `  ${theme.fg("muted", item.label)}`;
	}

	private trackLeft(): number {
		return this.leftIndicator ? INDICATOR_WIDTH : 0;
	}

	private trackRightReserve(): number {
		return this.rightIndicator ? INDICATOR_WIDTH : 0;
	}

	private prefixReserve(): number {
		const width = this.currentPrefixSpan().width;
		return width > 0 ? width + SEP : 0;
	}

	private currentPrefixSpan(): PowerbarPrefixSpan {
		if (this.mode === "model-search") {
			const text = `${theme.fg("accent", SEARCH_PREFIX)}${theme.bold(this.query)}${theme.fg("dim", SEARCH_CURSOR)}`;
			return { text, width: this.computeSearchPrefixWidth() };
		}
		if (this.mode === "thinking" && this.modelPrefix) return this.modelPrefix;
		return { text: "", width: 0 };
	}

	private computeSearchPrefixWidth(): number {
		return visibleWidth(SEARCH_PREFIX) + visibleWidth(this.query) + visibleWidth(SEARCH_CURSOR);
	}

	private trackMaxWidth(): number {
		return this.lastMaxWidth - this.trackLeft() - this.trackRightReserve() - this.prefixReserve();
	}

	private inWindow(index: number): boolean {
		return index >= this.windowStart && index <= this.windowEnd;
	}

	/**
	 * Choose the visible window around `center`: neighbors are added in reveal
	 * order (right before left) while they fit. Run twice so the edge indicators
	 * reserved for the final window are accounted for.
	 */
	private fitWindow(center: number, trackMax: number): void {
		const order = this.revealOrderFrom(center);
		let reserved = 2 * INDICATOR_WIDTH;
		let start = center;
		let end = center;
		for (let pass = 0; pass < 2; pass++) {
			const maxW = Math.max(1, trackMax - reserved);
			let used = 0;
			start = clampIndex(center, this.items.length);
			end = start;
			for (const idx of order) {
				const w = this.slotWidth(idx) + (used > 0 ? SEP : 0);
				if (used + w > maxW) break;
				used += w;
				start = Math.min(start, idx);
				end = Math.max(end, idx);
			}
			reserved = (start > 0 ? INDICATOR_WIDTH : 0) + (end < this.items.length - 1 ? INDICATOR_WIDTH : 0);
		}
		this.windowStart = start;
		this.windowEnd = end;
		this.leftIndicator = start > 0;
		this.rightIndicator = end < this.items.length - 1;
	}

	/** Indices in reveal order: center first, then by growing distance, right before left. */
	private revealOrderFrom(center: number): number[] {
		const order: number[] = [];
		if (center >= 0 && center < this.items.length) order.push(center);
		for (let distance = 1; distance < this.items.length; distance++) {
			if (center + distance < this.items.length) order.push(center + distance);
			if (center - distance >= 0) order.push(center - distance);
		}
		return order;
	}

	/**
	 * Spans currently on screen, clipped to the track area. Single source of
	 * truth for rendering, hit regions, and seeding follow-up transitions.
	 */
	private computeLayout(maxWidth: number): LayoutSpan[] {
		const left = this.trackLeft();
		const right = maxWidth - this.trackRightReserve();
		const spans: Array<{ index: number; label: string; selected: boolean; col: number; width: number }> = [];

		const transition = this.transition;
		if (transition?.kind === "wipe") {
			let running = left;
			const sorted = [...transition.entries].sort((a, b) => a.index - b.index);
			for (const entry of sorted) {
				const progress = (transition.tick - entry.start) / ITEM_FRAMES;
				const width = Math.round(entry.wFrom + (entry.wTo - entry.wFrom) * easeOutCubic(progress));
				if (width <= 0) continue;
				spans.push({ index: entry.index, label: entry.label, selected: entry.selected, col: running, width });
				running += width + SEP;
			}
		} else if (transition?.kind === "slide") {
			const progress = easeOutCubic(transition.tick / SLIDE_FRAMES);
			for (const entry of transition.entries) {
				const col = Math.round(entry.colFrom + (entry.colTo - entry.colFrom) * progress);
				spans.push({ index: entry.index, label: entry.label, selected: entry.selected, col, width: entry.width });
			}
			const prefix = this.currentPrefixSpan();
			if (prefix.width > 0) {
				spans.push({ index: -1, label: prefix.text, selected: false, col: left, width: prefix.width });
			}
		} else {
			const prefix = this.currentPrefixSpan();
			if (prefix.width > 0) {
				spans.push({ index: -1, label: prefix.text, selected: false, col: left, width: prefix.width });
			}
			let running = left + (prefix.width > 0 ? prefix.width + SEP : 0);
			for (let idx = this.windowStart; idx <= this.windowEnd; idx++) {
				const item = this.items[idx];
				if (!item) continue;
				spans.push({
					index: idx,
					label: this.slotText(idx),
					selected: idx === this.selectedIndex,
					col: running,
					width: this.slotWidth(idx),
				});
				running += this.slotWidth(idx) + SEP;
			}
		}

		const result: LayoutSpan[] = [];
		spans.sort((a, b) => a.col - b.col);
		for (const span of spans) {
			let { col, width } = span;
			let sliceStart = 0;
			if (col < left) {
				sliceStart += left - col;
				width -= left - col;
				col = left;
			}
			if (col + width > right) width = right - col;
			if (width <= 0) continue;
			result.push({ index: span.index, label: span.label, selected: span.selected, col, width, sliceStart });
		}
		return result;
	}

	/**
	 * Render the active track within `maxWidth`.
	 * Returns undefined in normal mode, where the caller renders its own labels.
	 */
	render(maxWidth: number): { text: string; regions: PowerbarRegion[] } | undefined {
		const widthChanged = maxWidth !== this.lastMaxWidth;
		this.lastMaxWidth = maxWidth;
		if (this.mode === "normal") {
			this.lastRegions = [];
			return undefined;
		}
		// Refit the window when the terminal is resized while a selector is open.
		if (widthChanged && !this.transition && this.items.length > 0) {
			this.fitWindow(clampIndex(this.selectedIndex, this.items.length), this.trackMaxWidth());
		}

		const spans = this.computeLayout(maxWidth);
		const regions: PowerbarRegion[] = [];
		const parts: string[] = [];
		let end = this.trackLeft();

		if (this.leftIndicator) parts.push(theme.fg("dim", "‹ "));

		for (const span of spans) {
			const text = sliceByColumn(span.label, span.sliceStart, span.width, true);
			const textWidth = visibleWidth(text);
			if (span.col > end) {
				parts.push(" ".repeat(span.col - end));
				end = span.col;
			}
			parts.push(text);
			end = Math.max(end, span.col + textWidth);
			if (span.index >= 0 && textWidth > 0) {
				regions.push({ start: span.col, width: textWidth, itemIndex: span.index });
			}
		}

		if (this.rightIndicator) {
			const right = maxWidth - 1;
			if (right > end) parts.push(" ".repeat(right - end));
			parts.push(theme.fg("dim", "›"));
		} else if (this.mode === "model-search" && this.items.length === 0) {
			parts.push(theme.fg("muted", "   no match"));
		}

		this.lastRegions = regions;
		return { text: parts.join(""), regions };
	}

	/** Index of the item rendered under `contentX` from the last render, or -1. */
	private itemIndexAt(contentX: number): number {
		for (const region of this.lastRegions) {
			if (contentX >= region.start && contentX < region.start + region.width) return region.itemIndex;
		}
		return -1;
	}

	/** Handle a click on the content area: select a hit item and confirm, otherwise collapse. */
	handleContentClick(contentX: number): void {
		if (this.mode === "normal" || this.collapsing || this.transition) return;
		const index = this.itemIndexAt(contentX);
		if (index === -1) {
			this.collapse();
			return;
		}
		this.selectedIndex = index;
		this.confirm(false);
	}

	// =========================================================================
	// Animation
	// =========================================================================

	private startWipe(entries: WipeEntry[], intervalMs: number, onComplete?: () => void): void {
		const last = entries.reduce((max, entry) => Math.max(max, entry.start + ITEM_FRAMES), 0);
		this.transition = { kind: "wipe", intervalMs, frames: last + 1, tick: 0, entries, onComplete };
		this.startTimer();
	}

	private startTimer(): void {
		this.stopTimer();
		this.timer = setInterval(() => {
			const transition = this.transition;
			if (!transition) {
				this.stopTimer();
				return;
			}
			transition.tick += 1;
			if (transition.tick >= transition.frames) {
				this.snapTransition();
			} else {
				this.host.requestRender();
			}
		}, this.transition?.intervalMs ?? WIPE_INTERVAL_MS);
	}

	private snapTransition(): void {
		this.stopTimer();
		const transition = this.transition;
		if (!transition) return;
		this.transition = undefined;
		if (transition.kind === "wipe") transition.onComplete?.();
	}

	private stopTimer(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}
