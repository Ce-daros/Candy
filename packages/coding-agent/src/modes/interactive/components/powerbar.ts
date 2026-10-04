import type { Api, Model } from "@candy/ai";
import { easeOutCubic, fuzzyFilter, MotionClock, motionDuration, sliceByColumn, visibleWidth } from "@candy/tui";
import type { AnimationIntensity } from "../../../core/settings-manager.ts";
import { getModelSelectorSearchText } from "../model-search.ts";
import { selectionCursor, selectionMarkerSuffix, theme } from "../theme/theme.ts";

const PREFIX_GAP = 2;

/**
 * Slot width bounds. Labels longer than `SLOT_MAX_WIDTH - 4` columns are
 * middle-truncated so one long model name cannot squeeze out its neighbors;
 * very short labels pad up to `SLOT_MIN_WIDTH` so the track keeps a rhythm.
 */
const SLOT_MIN_WIDTH = 7;
const SLOT_MAX_WIDTH = 28;

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

export type PowerbarModelRef = Model<Api>;

/** One selectable entry of the model track. */
export interface PowerbarModelEntry {
	readonly model: PowerbarModelRef;
	/** Display label from the model catalog. */
	readonly label: string;
}

/** Dependencies the powerbar needs from the host application. */
export interface PowerbarHost {
	/** Request a TUI repaint (called once per animation frame). */
	requestRender(): void;
	/** Models available for direct selection. */
	getModels(): readonly PowerbarModelEntry[];
	/** Index of the current model in `getModels()`. */
	getCurrentModelIndex(): number;
	/** Apply a model selection. Errors are reported by the host. */
	applyModel(model: PowerbarModelRef): void;
}

type PowerbarMode = "normal" | "model-browse" | "model-search";

interface TrackItem {
	readonly model: PowerbarModelEntry;
	readonly label: string;
	readonly width: number;
}

/** A clickable range relative to the content area (after the frame corner). */
export interface PowerbarRegion {
	readonly start: number;
	readonly width: number;
	readonly itemIndex: number;
}

/** Search prefix rendered before the model track. */
interface PowerbarPrefixSpan {
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

function clampIndex(value: number, size: number): number {
	if (size === 0) return 0;
	return Math.min(Math.max(0, value), size - 1);
}

/**
 * Shorten `label` to at most `maxCols` columns with an ellipsis in the middle,
 * keeping the head (provider/family name) and the tail (variants like
 * "(batch)"). Returns `label` unchanged when it already fits.
 */
function middleTruncate(label: string, maxCols: number): string {
	const total = visibleWidth(label);
	if (total <= maxCols) return label;
	if (maxCols <= 1) return "…";
	const keep = maxCols - 1;
	const head = Math.ceil(keep * 0.6);
	const tail = keep - head;
	return `${sliceByColumn(label, 0, head)}…${sliceByColumn(label, total - tail, tail)}`;
}

/**
 * Inline selector living in the editor's bottom border ("Powerbar").
 *
 * The track is a row of fixed-size slots laid out cumulatively from the left.
 * Opening, collapsing, and filtering animate each slot's width over discrete
 * frames with ease-out: pushed items glide to their new columns while entering
 * items are revealed underneath them. Selecting collapses the track back
 * around the new value.
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
	private searchPrefixWidth = 0;
	private query = "";
	/** The closing track remains visible after input returns to the editor. */
	private collapsing = false;
	private transition: Transition | undefined;
	private readonly clock = new MotionClock();
	private lastMaxWidth = 80;
	private lastRegions: PowerbarRegion[] = [];
	private animationsEnabled = true;
	private animationIntensity: AnimationIntensity = "moderate";

	constructor(host: PowerbarHost) {
		this.host = host;
	}

	isIdle(): boolean {
		return this.mode === "normal" || this.collapsing;
	}

	getHighlightedModel(): PowerbarModelRef | undefined {
		if (this.isIdle()) return undefined;
		return this.items[this.selectedIndex]?.model?.model;
	}

	setAnimationOptions(enabled: boolean, intensity: AnimationIntensity): void {
		this.animationsEnabled = enabled;
		this.animationIntensity = intensity;
		if (!enabled) this.snapTransition();
		else if (this.transition) this.startTimer();
		this.host.requestRender();
	}

	dispose(): void {
		this.stopTimer();
		this.mode = "normal";
		this.transition = undefined;
	}

	// =========================================================================
	// Opening / closing
	// =========================================================================

	/** Expand the model track out of the model label. */
	openModelBrowse(options: { anchorWidth: number }): void {
		this.stopTimer();
		this.collapsing = false;
		this.mode = "model-browse";
		this.leftIndicator = false;
		this.rightIndicator = false;
		this.items = this.host.getModels().map((entry) => ({
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
				wTo: 0,
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
	confirm(): void {
		if (this.mode === "normal" || this.collapsing) return;
		const item = this.items[this.selectedIndex];
		if (!item) {
			this.collapse();
			return;
		}
		this.snapTransition();
		this.host.applyModel(item.model.model);
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
		const shift = this.slotWidth(outgoing) * (direction === 1 ? 1 : -1);
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
			intervalMs: this.interval(SLIDE_INTERVAL_MS),
			frames: SLIDE_FRAMES + 1,
			tick: 0,
			entries,
		};
		if (this.animationsEnabled) this.startTimer();
		else this.snapTransition();
	}

	/** Column of `index` when the window starts at `start` (slots packed from `left`). */
	private cumulativeCol(index: number, start: number, left: number): number {
		const prefixWidth = this.currentPrefixSpan().width;
		let col = left + (prefixWidth > 0 ? prefixWidth + PREFIX_GAP : 0);
		for (let i = start; i < index; i++) col += this.slotWidth(i);
		return col;
	}

	// =========================================================================
	// Layout and rendering
	// =========================================================================

	private slotWidth(index: number): number {
		const width = (this.items[index]?.width ?? 0) + 4;
		return Math.min(Math.max(width, SLOT_MIN_WIDTH), SLOT_MAX_WIDTH);
	}

	/** Rendered text for an item's slot: label centered, or `‹ label ›` when highlighted. */
	private slotText(index: number): string {
		const item = this.items[index];
		if (!item) return "";
		const content = middleTruncate(item.label, this.slotWidth(index) - 4);
		const label = theme.fg("accent", content);
		if (index === this.selectedIndex) {
			return theme.bold(`${selectionCursor(true)}${label}${selectionMarkerSuffix(true)}`);
		}
		return `  ${theme.fg("muted", content)}`;
	}

	private trackLeft(): number {
		return this.leftIndicator ? INDICATOR_WIDTH : 0;
	}

	private trackRightReserve(): number {
		return this.rightIndicator ? INDICATOR_WIDTH : 0;
	}

	private prefixReserve(): number {
		const width = this.currentPrefixSpan().width;
		return width > 0 ? width + PREFIX_GAP : 0;
	}

	private currentPrefixSpan(): PowerbarPrefixSpan {
		if (this.mode === "model-search") {
			const text = `${theme.fg("accent", SEARCH_PREFIX)}${theme.bold(this.query)}${theme.fg("dim", SEARCH_CURSOR)}`;
			return { text, width: this.computeSearchPrefixWidth() };
		}
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
				const w = this.slotWidth(idx);
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
				const eased = entry.wTo < entry.wFrom ? 1 - easeOutCubic(1 - progress) : easeOutCubic(progress);
				const width = Math.round(entry.wFrom + (entry.wTo - entry.wFrom) * eased);
				if (width <= 0) continue;
				spans.push({ index: entry.index, label: entry.label, selected: entry.selected, col: running, width });
				running += width + (entry.index === -1 ? PREFIX_GAP : 0);
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
			let running = left + (prefix.width > 0 ? prefix.width + PREFIX_GAP : 0);
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
				running += this.slotWidth(idx);
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

		if (this.leftIndicator) parts.push(theme.fg("borderAccent", "‹ "));

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
			parts.push(theme.fg("borderAccent", "›"));
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
		this.confirm();
	}

	// =========================================================================
	// Animation
	// =========================================================================

	private startWipe(entries: WipeEntry[], intervalMs: number, onComplete?: () => void): void {
		const last = entries.reduce((max, entry) => Math.max(max, entry.start + ITEM_FRAMES), 0);
		this.transition = {
			kind: "wipe",
			intervalMs: this.interval(intervalMs),
			frames: last + 1,
			tick: 0,
			entries,
			onComplete,
		};
		if (this.animationsEnabled) this.startTimer();
		else this.snapTransition();
	}

	private interval(base: number): number {
		return Math.max(
			20,
			Math.round(motionDuration(base, this.animationIntensity, { conservative: 1.8, moderate: 1, aggressive: 0.7 })),
		);
	}

	private startTimer(): void {
		this.stopTimer();
		this.clock.start(this.transition?.intervalMs ?? WIPE_INTERVAL_MS, () => {
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
		});
	}

	private snapTransition(): void {
		this.stopTimer();
		const transition = this.transition;
		if (!transition) return;
		this.transition = undefined;
		if (transition.kind === "wipe") transition.onComplete?.();
	}

	private stopTimer(): void {
		this.clock.stop();
	}
}
