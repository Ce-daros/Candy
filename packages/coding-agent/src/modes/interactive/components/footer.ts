import { truncateToWidth, visibleWidth } from "@candy/tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { AnimationIntensity } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import type { EditorBottomStatus } from "./custom-editor.ts";
import type { FrameMotion } from "./frame-motion.ts";
import { PowerbarController, type PowerbarHost } from "./powerbar.ts";

/** Frame corner that opens the merged bottom border. */
const BOTTOM_BORDER_CORNER = "╰── ";

/** Chevron hinting that a segment can be changed. */
const SELECTOR_CHEVRON = "▾";

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
 * Status line merged into the editor's bottom border.
 *
 * With a PowerbarHost, the model and effort labels become clickable anchors
 * for the inline Powerbar selectors (see powerbar.ts).
 */
export class FooterComponent implements EditorBottomStatus {
	private session: AgentSession;
	private readonly powerbar: PowerbarController | undefined;
	private lastModelRegion: LabelRegion | undefined;
	private lastThinkingRegion: LabelRegion | undefined;
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
	 * narrow: scroll hint first, then the effort selector, then a truncated model.
	 * Also records the clickable regions of the model and effort labels.
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
			this.lastThinkingRegion = thinking
				? { start: modelStart + modelWidth + gapWidth, width: visibleWidth(thinking) }
				: undefined;
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

	/** Expand the thinking level track out of the effort label. Returns false when the Powerbar is unavailable. */
	openPowerbarThinking(): boolean {
		if (!this.powerbar) return false;
		const model = this.session.state.model;
		if (!model?.reasoning) return false;
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

	switchPowerbar(direction: 1 | -1): boolean {
		if (!this.powerbar || this.powerbar.isIdle()) return false;
		if (direction === -1 && this.powerbar.mode === "thinking") return this.openPowerbarModelBrowse();
		if (direction === 1 && this.powerbar.mode !== "thinking" && this.session.state.model?.reasoning) {
			return this.openPowerbarThinking();
		}
		return true;
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
		const name = model ? modelDisplayName(model) : "no-model";
		const label = `${name} ${SELECTOR_CHEVRON}`;
		if (this.frameMotion) return this.frameMotion.paintLabel(label, "text");
		return `${name} ${theme.fg("dim", SELECTOR_CHEVRON)}`;
	}

	/** Thinking level, only for models that support reasoning. */
	private thinkingLabel(): string | undefined {
		const model = this.session.state.model;
		if (!model?.reasoning) return undefined;
		const level = this.session.state.thinkingLevel || "off";
		const label = `${level.charAt(0).toUpperCase() + level.slice(1)} ${SELECTOR_CHEVRON}`;
		if (this.frameMotion) return this.frameMotion.paintLabel(label, "muted");
		return `${theme.fg("muted", level.charAt(0).toUpperCase() + level.slice(1))} ${theme.fg("dim", SELECTOR_CHEVRON)}`;
	}
}
