import { truncateToWidth, visibleWidth } from "@candy/tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { AnimationIntensity } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import type { EditorBottomStatus } from "./custom-editor.ts";
import { type FrameMotion, thinkingMeter } from "./frame-motion.ts";
import { PowerbarController, type PowerbarHost, type PowerbarModelRef } from "./powerbar.ts";

/** Frame corner that opens the merged bottom border. */
const BOTTOM_BORDER_CORNER = "╰── ";

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

export function modelDisplayName(model: { name: string }): string {
	return model.name;
}

/** Clickable range relative to the content area (after the frame corner). */
interface LabelRegion {
	start: number;
	width: number;
}

/**
 * Status line merged into the editor's bottom border.
 *
 * With a PowerbarHost, the model label opens the inline model selector.
 */
export class FooterComponent implements EditorBottomStatus {
	private session: AgentSession;
	private readonly powerbar: PowerbarController | undefined;
	private lastModelRegion: LabelRegion | undefined;
	private frameMotion: FrameMotion | undefined;

	constructor(session: AgentSession, powerbarHost?: PowerbarHost) {
		this.session = session;
		this.powerbar = powerbarHost ? new PowerbarController(powerbarHost) : undefined;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setFrameMotion(motion: FrameMotion): void {
		this.frameMotion = motion;
	}

	setAnimationOptions(enabled: boolean, intensity: AnimationIntensity): void {
		this.powerbar?.setAnimationOptions(enabled, intensity);
	}

	getBorderAnchors(width: number): { left: number; right: number } {
		const modelWidth = visibleWidth(this.modelLabel());
		const thinking = this.thinkingLabel();
		const end = 4 + modelWidth + (thinking ? 3 + visibleWidth(thinking) : 0);
		return { left: Math.min(4, Math.max(0, width - 1)), right: Math.min(Math.max(0, width - 2), end) };
	}

	/** State is read at render time. */
	invalidate(): void {}

	dispose(): void {
		this.powerbar?.dispose();
	}

	renderBottomBorder(width: number, hiddenLineCount: number, borderColor: (text: string) => string): string {
		if (width <= 0) return "";
		const paint = (text: string, column: number): string =>
			this.frameMotion?.paintBorder(text, column, this.frameMotion.getBottomRow()) ?? borderColor(text);
		if (width === 1) return paint("╰", 0);
		if (width < 7) return paint(`╰${"─".repeat(width - 2)}╯`, 0);

		const maxWidth = Math.max(0, width - 5);
		const activeTrack = this.powerbar?.render(maxWidth);
		const labels = activeTrack ? activeTrack.text : this.buildLabels(maxWidth, hiddenLineCount, paint);
		const labelsWidth = visibleWidth(labels);
		const rest = width - visibleWidth(BOTTOM_BORDER_CORNER) - labelsWidth - 1;
		const space = rest > 0 ? " " : "";
		return (
			paint(BOTTOM_BORDER_CORNER, 0) +
			labels +
			paint(`${space}${"─".repeat(Math.max(0, rest - space.length))}╯`, 4 + labelsWidth)
		);
	}

	/**
	 * Model and effort labels, dropping lower-priority parts when the terminal is
	 * narrow: scroll hint first, then the effort label, then a truncated model.
	 * Also records the model label's clickable region.
	 */
	private buildLabels(
		maxWidth: number,
		hiddenLineCount: number,
		paint: (text: string, column: number) => string,
	): string {
		const model = this.modelLabel();
		const thinking = this.thinkingLabel();
		const scroll = hiddenLineCount > 0 ? `↓ ${hiddenLineCount} more` : "";
		const gapWidth = visibleWidth("   ");
		const modelWidth = visibleWidth(model);
		const recordRegions = (modelStart: number): void => {
			this.lastModelRegion = model ? { start: modelStart, width: modelWidth } : undefined;
		};

		const modelStart = scroll ? visibleWidth(scroll) + gapWidth : 0;
		const joined = (start: number): string =>
			`${model}${thinking ? ` ${paint("─", 4 + start + modelWidth + 1)} ${thinking}` : ""}`;
		const full = `${scroll ? `${scroll}   ` : ""}${joined(modelStart)}`;
		if (visibleWidth(full) <= maxWidth) {
			recordRegions(scroll ? visibleWidth(scroll) + gapWidth : 0);
			return full;
		}
		const withoutScroll = joined(0);
		if (visibleWidth(withoutScroll) <= maxWidth) {
			recordRegions(0);
			return withoutScroll;
		}
		recordRegions(0);
		if (visibleWidth(model) <= maxWidth) return model;
		return maxWidth > 0 ? truncateToWidth(model, maxWidth, "…") : "";
	}

	// =========================================================================
	// Powerbar (inline selectors in this border)
	// =========================================================================

	/** True when no inline selector is open. */
	isPowerbarIdle(): boolean {
		return !this.powerbar || this.powerbar.isIdle();
	}

	/** Expand the model track out of the model label. Returns false when the Powerbar is unavailable. */
	openPowerbarModelBrowse(): boolean {
		if (!this.powerbar) return false;
		const model = this.session.selection.model;
		const modelName = model ? modelDisplayName(model) : "no-model";
		this.powerbar.openModelBrowse({ anchorWidth: visibleWidth(modelName) });
		return true;
	}

	/** Collapse the active selector back to the normal labels. */
	cancelPowerbar(): void {
		this.powerbar?.collapse();
	}

	/** Confirm the highlighted item. */
	confirmPowerbar(): void {
		this.powerbar?.confirm();
	}

	movePowerbar(delta: number): void {
		this.powerbar?.move(delta);
	}

	getHighlightedModel(): PowerbarModelRef | undefined {
		return this.powerbar?.getHighlightedModel();
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
			return false;
		}
		this.powerbar.handleContentClick(contentX);
		return true;
	}

	private inRegion(region: LabelRegion | undefined, x: number): boolean {
		return region !== undefined && x >= region.start && x < region.start + region.width;
	}

	/** Display name from the model catalog. */
	private modelLabel(): string {
		const model = this.session.selection.model;
		const name = model ? modelDisplayName(model) : "No model selected";
		if (!model) return theme.fg("error", name);
		if (this.frameMotion) return this.frameMotion.paintLabel(name, "accent");
		return theme.fg("accent", name);
	}

	/** Thinking level, including Off for models without reasoning. */
	private thinkingLabel(): string {
		const model = this.session.selection.model;
		const level = model?.reasoning
			? (this.frameMotion?.getThinking() ?? this.session.selection.thinkingLevel)
			: "off";
		const label = `${level.charAt(0).toUpperCase() + level.slice(1)} ${thinkingMeter(level)}`;
		if (this.frameMotion) return this.frameMotion.paintThinking(label);
		return theme.getThinkingBorderColor(level)(label);
	}
}
