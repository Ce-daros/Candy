import { truncateToWidth, visibleWidth } from "@candy/tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { theme } from "../theme/theme.ts";
import type { EditorBottomStatus } from "./custom-editor.ts";
import { PowerbarController, type PowerbarHost } from "./powerbar.ts";

/** Frame corner that opens the merged bottom border. */
const BOTTOM_BORDER_CORNER = "╰── ";

/** Separator between the model/effort cluster and the context meter. */
const METER_SEPARATOR = " ─";

/** Chevron hinting that a segment can be changed. */
const SELECTOR_CHEVRON = "▾";

/** Smallest meter that can still show a percentage readout with its frontier. */
const MIN_METER_WIDTH = 6;

/** Filled portion of the context meter. */
const METER_FILLED = "━";

/** Remaining portion of the context meter. */
const METER_REMAINING = "─";

/** Frontier between filled and remaining context. */
const METER_FRONTIER = "╾";

/** Context the current composer text is expected to add. */
const METER_PENDING = "┄";

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

/**
 * Format token counts for compact display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Display name for the status line: the catalog name without a leading
 * `<Vendor>: ` prefix, falling back to the last path segment of the id.
 *
 * Catalog names use `<Vendor>: <Model>` (for example `MoonshotAI: Kimi K2.6`),
 * while gateway ids embed the vendor as a path prefix (`moonshotai/kimi-k2.6`).
 * Model names themselves are never rewritten.
 */
export function modelDisplayName(model: { id: string; name?: string }): string {
	const name = model.name?.trim();
	if (name) return name.replace(/^[^:]+:\s+/, "");
	const separator = model.id.lastIndexOf("/");
	return separator === -1 ? model.id : model.id.slice(separator + 1);
}

/** Clickable range relative to the content area (after the frame corner). */
interface LabelRegion {
	start: number;
	width: number;
}

/**
 * Status line merged into the editor's bottom border:
 * `╰── <model> ▾   <effort> ▾ ─━━━━ 42% ╾────╯`.
 * The remaining border is the context meter: filled cells track current
 * context, dashed cells track the projected context of the pending prompt,
 * and the current percentage is always shown.
 *
 * With a PowerbarHost, the model and effort labels become clickable anchors
 * for the inline Powerbar selectors (see powerbar.ts).
 */
export class FooterComponent implements EditorBottomStatus {
	private session: AgentSession;
	private pendingTokens: number | undefined;
	private readonly powerbar: PowerbarController | undefined;
	private lastModelRegion: LabelRegion | undefined;
	private lastThinkingRegion: LabelRegion | undefined;

	constructor(session: AgentSession, powerbarHost?: PowerbarHost) {
		this.session = session;
		this.powerbar = powerbarHost ? new PowerbarController(powerbarHost) : undefined;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(_enabled: boolean): void {
		// The compact mode does not affect the context meter.
	}

	/** Pending context tokens the current composer text would add, if estimable. */
	setPendingTokens(tokens: number | undefined): void {
		this.pendingTokens = tokens;
	}

	/**
	 * No-op: state is read at render time.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No cached state to invalidate
	}

	/**
	 * No-op: the status line holds no resources of its own.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	dispose(): void {
		this.powerbar?.dispose();
		// Nothing else to release
	}

	renderBottomBorder(width: number, hiddenLineCount: number, borderColor: (text: string) => string): string {
		if (width <= 0) return "";
		if (width === 1) return borderColor("╰");
		if (width < 7) return borderColor(`╰${"─".repeat(width - 2)}╯`);

		const maxWidth = Math.max(0, width - 5);
		const activeTrack = this.powerbar?.render(maxWidth);
		const labels = activeTrack ? activeTrack.text : this.buildLabels(maxWidth, hiddenLineCount);
		const labelsWidth = visibleWidth(labels);
		const meterWidth = width - visibleWidth(BOTTOM_BORDER_CORNER) - labelsWidth - visibleWidth(METER_SEPARATOR) - 1;

		// Too narrow for a usable meter: keep the frame and fill with plain border.
		if (meterWidth < MIN_METER_WIDTH) {
			const rest = width - visibleWidth(BOTTOM_BORDER_CORNER) - labelsWidth - 1;
			const space = rest > 0 ? " " : "";
			const fill = Math.max(0, rest - space.length);
			return borderColor(BOTTOM_BORDER_CORNER) + labels + borderColor(`${space}${METER_REMAINING.repeat(fill)}╯`);
		}

		return (
			borderColor(BOTTOM_BORDER_CORNER) +
			labels +
			borderColor(METER_SEPARATOR) +
			this.renderMeter(meterWidth, borderColor) +
			borderColor("╯")
		);
	}

	/**
	 * Model and effort labels, dropping lower-priority parts when the terminal is
	 * narrow: scroll hint first, then the effort selector, then a truncated model.
	 * Also records the clickable regions of the model and effort labels.
	 */
	private buildLabels(maxWidth: number, hiddenLineCount: number): string {
		const model = this.modelLabel();
		const thinking = this.thinkingLabel();
		const scroll = hiddenLineCount > 0 ? `↓ ${hiddenLineCount} more` : "";
		const gapWidth = visibleWidth("   ");
		const modelWidth = visibleWidth(model);
		const recordRegions = (modelStart: number): void => {
			this.lastModelRegion = model ? { start: modelStart, width: modelWidth } : undefined;
			this.lastThinkingRegion = thinking
				? { start: modelStart + modelWidth + gapWidth, width: visibleWidth(thinking) }
				: undefined;
		};

		const full = `${scroll ? `${scroll}   ` : ""}${model}${thinking ? `   ${thinking}` : ""}`;
		if (visibleWidth(full) <= maxWidth) {
			recordRegions(scroll ? visibleWidth(scroll) + gapWidth : 0);
			return full;
		}
		const withoutScroll = `${model}${thinking ? `   ${thinking}` : ""}`;
		if (visibleWidth(withoutScroll) <= maxWidth) {
			recordRegions(0);
			return withoutScroll;
		}
		recordRegions(0);
		if (visibleWidth(model) <= maxWidth) return model;
		return maxWidth > 0 ? truncateToWidth(model, maxWidth, "…") : "";
	}

	/**
	 * Context meter. `━` is used context, `┄` is the pending prompt's projected
	 * context, `─` is remaining, and `╾` marks each frontier.
	 */
	private renderMeter(width: number, borderColor: (text: string) => string): string {
		const usage = this.session.getContextUsage();
		const contextWindow = usage?.contextWindow ?? 0;
		const rawPercent = usage?.percent;
		if (rawPercent === null || rawPercent === undefined || !Number.isFinite(rawPercent)) {
			return borderColor(METER_REMAINING.repeat(width));
		}

		const current = clampPercent(rawPercent);
		const projected =
			this.pendingTokens !== undefined && this.pendingTokens > 0 && contextWindow > 0
				? clampPercent(current + (this.pendingTokens / contextWindow) * 100)
				: null;
		const showPending = projected !== null && Math.round(projected) > Math.round(current);

		const currentLabel = ` ${Math.round(current)}% `;
		const pendingLabel = showPending ? ` ${Math.round(projected)}% ` : "";
		// The pending frontier is omitted only when the projection actually reaches the right border.
		const pendingFrontier = showPending && projected < 100 ? 1 : 0;
		const frontiers = 1 + pendingFrontier;

		// The percentage is always shown, so a meter too narrow to hold it degrades to a
		// plain border instead of breaking the frame. The pending label is dropped first
		// because the current percentage is the more useful number.
		let includePendingLabel = showPending;
		let labelWidth = currentLabel.length + (includePendingLabel ? pendingLabel.length : 0);
		if (width - frontiers - labelWidth < 0 && includePendingLabel) {
			includePendingLabel = false;
			labelWidth -= pendingLabel.length;
		}
		if (width - frontiers - labelWidth < 0) {
			return borderColor(METER_REMAINING.repeat(width));
		}

		const trackWidth = Math.max(0, width - frontiers - labelWidth);
		const filledCurrent = Math.round((current / 100) * trackWidth);
		let filledPending = 0;
		if (showPending) {
			filledPending = Math.max(0, Math.round((projected / 100) * trackWidth) - filledCurrent);
		}
		const remaining = Math.max(0, trackWidth - filledCurrent - filledPending);

		let meter = filledCurrent > 0 ? theme.bold(METER_FILLED.repeat(filledCurrent)) : "";
		meter += theme.fg("muted", currentLabel);
		meter += borderColor(METER_FRONTIER);
		if (showPending) {
			if (filledPending > 0) meter += theme.fg("dim", METER_PENDING.repeat(filledPending));
			if (includePendingLabel) meter += theme.fg("muted", pendingLabel);
			if (pendingFrontier > 0) meter += borderColor(METER_FRONTIER);
		}
		if (remaining > 0) meter += borderColor(METER_REMAINING.repeat(remaining));
		return meter;
	}

	// =========================================================================
	// Powerbar (inline selectors in this border)
	// =========================================================================

	/** True when no inline selector is open. */
	isPowerbarIdle(): boolean {
		return !this.powerbar || this.powerbar.isIdle();
	}

	/** Expand the thinking level track out of the effort label. Returns false when the Powerbar is unavailable. */
	openPowerbarThinking(): boolean {
		if (!this.powerbar) return false;
		const model = this.session.state.model;
		const modelName = model ? modelDisplayName(model) : "no-model";
		const thinkingLevel = this.session.state.thinkingLevel || "off";
		const anchorLabel = `${thinkingLevel.charAt(0).toUpperCase() + thinkingLevel.slice(1)} ${SELECTOR_CHEVRON}`;
		this.powerbar.openThinking({
			anchorWidth: visibleWidth(anchorLabel),
			prefix: {
				text: `${modelName} ${theme.fg("dim", SELECTOR_CHEVRON)}`,
				width: visibleWidth(`${modelName} ${SELECTOR_CHEVRON}`),
			},
		});
		return true;
	}

	/** Expand the model track out of the model label. Returns false when the Powerbar is unavailable. */
	openPowerbarModelBrowse(): boolean {
		if (!this.powerbar) return false;
		const model = this.session.state.model;
		const modelName = model ? modelDisplayName(model) : "no-model";
		const anchorLabel = `${modelName} ${SELECTOR_CHEVRON}`;
		this.powerbar.openModelBrowse({ anchorWidth: visibleWidth(anchorLabel) });
		return true;
	}

	/** Collapse the active selector back to the normal labels. */
	cancelPowerbar(): void {
		this.powerbar?.collapse();
	}

	/** Confirm the highlighted item; persist=true also saves it as the default. */
	confirmPowerbar(persist = false): void {
		this.powerbar?.confirm(persist);
	}

	movePowerbar(delta: number): void {
		this.powerbar?.move(delta);
	}

	powerbarInputChar(char: string): void {
		this.powerbar?.inputChar(char);
	}

	powerbarBackspace(): void {
		this.powerbar?.backspace();
	}

	/**
	 * Handle a left click on this border row. `x` is the border-row column.
	 * Returns false when the Powerbar is unavailable and the click is not on a label.
	 */
	handleBottomBorderClick(x: number): boolean {
		if (!this.powerbar) return false;
		const contentX = x - visibleWidth(BOTTOM_BORDER_CORNER);
		if (this.powerbar.isIdle()) {
			if (this.inRegion(this.lastModelRegion, contentX)) {
				return this.openPowerbarModelBrowse();
			}
			if (this.inRegion(this.lastThinkingRegion, contentX)) {
				return this.openPowerbarThinking();
			}
			return false;
		}
		this.powerbar.handleContentClick(contentX);
		return true;
	}

	private inRegion(region: LabelRegion | undefined, x: number): boolean {
		return region !== undefined && x >= region.start && x < region.start + region.width;
	}

	/** Short model name, without the provider prefix or context window. */
	private modelLabel(): string {
		const model = this.session.state.model;
		if (!model) return "no-model";
		return `${modelDisplayName(model)} ${theme.fg("dim", SELECTOR_CHEVRON)}`;
	}

	/** Thinking level, only for models that support reasoning. */
	private thinkingLabel(): string | undefined {
		const model = this.session.state.model;
		if (!model?.reasoning) return undefined;
		const level = this.session.state.thinkingLevel || "off";
		return `${theme.fg("muted", level.charAt(0).toUpperCase() + level.slice(1))} ${theme.fg("dim", SELECTOR_CHEVRON)}`;
	}
}
