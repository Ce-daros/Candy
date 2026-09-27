import type { ThinkingLevel } from "@candy/agent-core";
import { colorToOklch, foregroundAnsi, mixColors, oklchColor, parseColor, type TUI, visibleWidth } from "@candy/tui";
import type { AnimationIntensity } from "../../../core/settings-manager.ts";
import { getResolvedThemeColors, isLightTheme, theme } from "../theme/theme.ts";
import type { StatusIndicatorKind } from "./status-indicator.ts";

export type ShellMode = "normal" | "shell" | "shell-no-context";

const TIMING: Record<AnimationIntensity, { entrance: number; transition: number; frame: number; status: number }> = {
	conservative: { entrance: 700, transition: 480, frame: 45, status: 150 },
	moderate: { entrance: 520, transition: 360, frame: 24, status: 90 },
	aggressive: { entrance: 350, transition: 240, frame: 16, status: 55 },
};

const RAMP_STEPS = 8;

function smoothstep(value: number): number {
	const p = Math.max(0, Math.min(1, value));
	return p * p * (3 - 2 * p);
}

interface Transition {
	from: ShellMode;
	to: ShellMode;
	start: number;
	previous?: { transition: Transition; at: number };
}

type Ink = "hidden" | "base" | "dim" | number;

/** The border's geometry, mode color, and activity highlights share one clock. */
export class FrameMotion {
	private readonly ui: TUI;
	private enabled = true;
	private intensity: AnimationIntensity = "moderate";
	private mode: ShellMode = "normal";
	private transition: Transition | undefined;
	private entranceStart: number | undefined;
	private entrancePending = true;
	private status: StatusIndicatorKind | undefined;
	private statusStart = 0;
	private thinking: ThinkingLevel = "off";
	private timer: NodeJS.Timeout | undefined;
	private paletteKey = "";
	private borderRamp: string[] = [];
	private statusRamps: string[][] = [];
	private titleRamp: string[] = [];
	private labelRamps: Record<"text" | "muted", string[]> = { text: [], muted: [] };
	private width = 80;
	private rows = 4;
	private leftAnchor = 4;
	private rightAnchor = 30;

	constructor(ui: TUI) {
		this.ui = ui;
	}

	beginFrame(): void {
		if (!this.enabled || !this.entrancePending) return;
		this.entrancePending = false;
		this.entranceStart = performance.now();
		this.startTimer();
	}

	setGeometry(width: number, rows: number, leftAnchor: number, rightAnchor: number): void {
		this.width = width;
		this.rows = rows;
		this.leftAnchor = leftAnchor;
		this.rightAnchor = rightAnchor;
	}

	setOptions(enabled: boolean, intensity: AnimationIntensity): void {
		this.enabled = enabled;
		this.intensity = intensity;
		if (!enabled) {
			this.transition = undefined;
			this.entranceStart = -Infinity;
			this.entrancePending = false;
		}
		this.startTimer();
		this.ui.requestRender();
	}

	setMode(mode: ShellMode): void {
		if (this.mode === mode) return;
		const from = this.mode;
		this.mode = mode;
		const now = performance.now();
		this.transition = this.enabled
			? {
					from,
					to: mode,
					start: now,
					previous: this.transition ? { transition: this.transition, at: now } : undefined,
				}
			: undefined;
		this.startTimer();
		this.ui.requestRender();
	}

	getMode(): ShellMode {
		return this.mode;
	}

	getShellTitle(): string {
		const mode =
			this.mode === "normal" || (this.mode === "shell" && this.transition?.from === "shell-no-context")
				? this.transition?.from
				: this.mode;
		return mode === "shell-no-context" ? "Shell · No Context" : mode === "shell" ? "Shell" : "";
	}

	getBottomRow(): number {
		return this.rows - 1;
	}

	restartEntrance(): void {
		this.transition = undefined;
		this.entranceStart = this.enabled ? undefined : -Infinity;
		this.entrancePending = this.enabled;
		this.startTimer();
		this.ui.requestRender();
	}

	setStatus(status: StatusIndicatorKind | undefined): void {
		if (this.status === status) return;
		this.status = status;
		this.statusStart = performance.now();
		this.startTimer();
		this.ui.requestRender();
	}

	getStatus(): StatusIndicatorKind | undefined {
		return this.status;
	}

	setThinking(level: ThinkingLevel): void {
		this.thinking = level;
		this.ui.requestRender();
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	getLabelPhase(): number {
		if (!this.enabled) return RAMP_STEPS;
		const p = Math.min(1, this.entranceProgress() / 0.8);
		return Math.min(RAMP_STEPS, Math.floor(p * (RAMP_STEPS + 1)));
	}

	paintLabel(text: string, color: "text" | "muted"): string {
		const phase = this.getLabelPhase();
		if (phase === 0) return " ".repeat(visibleWidth(text));
		this.refreshPalette();
		return `${this.labelRamps[color][phase]}${text}\x1b[39m`;
	}

	getTitleProgress(): number {
		if (!this.enabled || !this.transition) return 1;
		return smoothstep((performance.now() - this.transition.start) / TIMING[this.intensity].transition);
	}

	paintBorder(text: string, startColumn: number, row: number): string {
		if (!text) return "";
		this.refreshPalette();
		const now = performance.now();
		let output = "";
		let group = "";
		let current: Ink | undefined;
		let currentColor = -1;
		const flush = (): void => {
			if (!group || current === undefined) return;
			output += this.style(group, current, currentColor);
			group = "";
		};
		for (let offset = 0; offset < text.length; offset++) {
			const column = startColumn + offset;
			const color = this.colorAt(column, row, now);
			const ink = this.inkAt(column, row, now);
			if (ink !== current || color !== currentColor) {
				flush();
				current = ink;
				currentColor = color;
			}
			group += ink === "hidden" ? " " : text[offset];
		}
		flush();
		return output;
	}

	paintTitle(text: string): string {
		if (!this.enabled) return theme.fg(this.mode === "normal" ? "border" : "bashMode", text);
		this.refreshPalette();
		const progress = this.getTitleProgress();
		const exiting = this.mode === "normal" && this.transition?.from !== "normal";
		const visible = exiting
			? Math.ceil(text.length * (1 - progress))
			: this.transition?.from === "shell-no-context" && this.mode === "shell"
				? Math.max(5, Math.ceil(text.length * (1 - progress)))
				: this.transition?.from === "shell" && this.mode === "shell-no-context"
					? Math.max(5, Math.ceil(text.length * progress))
					: text.length;
		const shown = text.slice(0, visible);
		const rest = " ".repeat(text.length - visible);
		const titleStep = Math.max(1, Math.round((exiting ? 1 - progress : progress) * RAMP_STEPS));
		return `${this.titleRamp[titleStep]}${shown}\x1b[39m${rest}`;
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private startTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.enabled) return;
		if (this.entrancePending && !this.transition) return;
		if (!this.status && !this.transition && this.entranceProgress() >= 1) return;
		const activeTransition = this.transition || this.entranceProgress() < 1;
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				if (this.transition && this.getTitleProgress() >= 1) this.transition = undefined;
				this.ui.requestRender();
				this.startTimer();
			},
			TIMING[this.intensity][activeTransition ? "frame" : "status"],
		);
		this.timer.unref();
	}

	private entranceProgress(): number {
		if (this.entranceStart === undefined) return 0;
		return smoothstep((performance.now() - this.entranceStart) / TIMING[this.intensity].entrance);
	}

	private colorAt(column: number, row: number, now: number): number {
		const transition = this.transition;
		if (!transition) return this.mode === "normal" ? 0 : RAMP_STEPS;
		return this.transitionColorAt(transition, column, row, now);
	}

	private transitionColorAt(transition: Transition, column: number, row: number, now: number): number {
		const progress = smoothstep((now - transition.start) / TIMING[this.intensity].transition);
		const shellBefore = transition.from !== "normal";
		const shellAfter = transition.to !== "normal";
		if (shellBefore === shellAfter) return shellAfter ? RAMP_STEPS : 0;
		const initial = transition.previous
			? this.transitionColorAt(transition.previous.transition, column, row, transition.previous.at)
			: shellBefore
				? RAMP_STEPS
				: 0;
		if (shellAfter) {
			const distance = this.distanceFromTitle(column, row, transition.to);
			const maximum = this.width / 2 + this.rows + this.width / 2;
			const reveal = smoothstep((progress - (distance / maximum) * 0.5) / 0.5);
			return Math.round(initial + (RAMP_STEPS - initial) * reveal);
		}
		const retract = smoothstep((progress - this.exitFraction(column, row, transition.from) * 0.5) / 0.5);
		return Math.round(initial * (1 - retract));
	}

	private inkAt(column: number, row: number, now: number): Ink {
		const entranceInk = this.enabled ? this.entranceInkAt(column, row) : "base";
		if (entranceInk !== "base") return entranceInk;
		if (!this.enabled || !this.status) return "base";
		const perimeter = Math.max(1, this.width * 2 + (this.rows - 2) * 2);
		const index = this.perimeterIndex(column, row);
		const phase = Math.floor((now - this.statusStart) / TIMING[this.intensity].status);
		const level = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].indexOf(this.thinking);
		const trail = 5 + Math.max(0, level) * 2;
		const peak = Math.min(RAMP_STEPS, 4 + Math.max(0, level));
		let distance: number;
		if (this.status === "working") {
			const head = (phase * 3) % perimeter;
			distance = Math.min(
				(head - index + perimeter) % perimeter,
				(head + perimeter / 2 - index + perimeter) % perimeter,
			);
		} else if (this.status === "retry") {
			const head = (phase * 7 + (phase % 4 === 0 ? 5 : 0)) % perimeter;
			distance = (head - index + perimeter) % perimeter;
		} else {
			const half = Math.floor(perimeter / 2);
			const head = (phase * 3) % half;
			distance = Math.min(Math.abs(index - head), Math.abs(index - (perimeter - head)));
		}
		return Math.max(0, Math.round((1 - distance / trail) * peak));
	}

	private entranceInkAt(column: number, row: number): Ink {
		const progress = this.entranceProgress();
		if (progress >= 1) return "base";
		const bottom = this.rows - 1;
		const center = Math.floor(this.width / 2);
		const leftLength = this.leftAnchor + bottom + center;
		const rightLength = this.width - 1 - this.rightAnchor + bottom + this.width - 1 - center;
		const maximum = Math.max(leftLength, rightLength);
		let distance: number;
		let delay = 0;
		if (row === bottom && column > this.leftAnchor && column < this.rightAnchor) {
			const halfGap = Math.ceil((this.rightAnchor - this.leftAnchor) / 2);
			distance = Math.min(column - this.leftAnchor, this.rightAnchor - column);
			delay = maximum - halfGap;
		} else if (row === bottom) {
			const left = column <= this.leftAnchor;
			distance = left ? this.leftAnchor - column : column - this.rightAnchor;
		} else if (column === 0 || column === this.width - 1) {
			const left = column === 0;
			distance = (left ? this.leftAnchor : this.width - 1 - this.rightAnchor) + bottom - row;
		} else {
			const left = column <= center;
			distance =
				(left ? this.leftAnchor : this.width - 1 - this.rightAnchor) +
				bottom +
				(left ? column : this.width - 1 - column);
		}
		const advance = progress * maximum - distance - delay;
		return advance < 0 ? "hidden" : advance < 3 ? "dim" : "base";
	}

	private distanceFromTitle(column: number, row: number, mode: ShellMode): number {
		const center = 7 + Math.floor((mode === "shell-no-context" ? 18 : 5) / 2);
		if (row === 0) return Math.abs(column - center);
		if (column === 0) return center + row;
		if (column === this.width - 1) return this.width - 1 - center + row;
		return Math.min(
			center + this.rows - 1 + column,
			this.width - 1 - center + this.rows - 1 + this.width - 1 - column,
		);
	}

	private exitFraction(column: number, row: number, from: ShellMode): number {
		const bottom = this.rows - 1;
		const titleEnd = Math.min(this.width - 1, 7 + (from === "shell-no-context" ? 18 : 5));
		const leftLength = Math.max(1, this.leftAnchor + bottom + Math.min(7, titleEnd));
		const rightLength = Math.max(1, this.width - 1 - this.rightAnchor + bottom + this.width - 1 - titleEnd);
		if (row === bottom && column > this.leftAnchor && column < this.rightAnchor) {
			const halfGap = Math.max(1, (this.rightAnchor - this.leftAnchor) / 2);
			return 0.7 + 0.3 * (Math.min(column - this.leftAnchor, this.rightAnchor - column) / halfGap);
		}
		if (row === bottom) {
			return column <= this.leftAnchor
				? (this.leftAnchor - column) / leftLength
				: (column - this.rightAnchor) / rightLength;
		}
		if (column === 0) return (this.leftAnchor + bottom - row) / leftLength;
		if (column === this.width - 1) return (this.width - 1 - this.rightAnchor + bottom - row) / rightLength;
		return column < titleEnd
			? (this.leftAnchor + bottom + column) / leftLength
			: (this.width - 1 - this.rightAnchor + bottom + this.width - 1 - column) / rightLength;
	}

	private perimeterIndex(column: number, row: number): number {
		if (row === 0) return column;
		if (column === this.width - 1) return this.width - 1 + row;
		if (row === this.rows - 1) return this.width - 1 + this.rows - 1 + this.width - 1 - column;
		return this.width * 2 + this.rows - 3 + this.rows - 1 - row;
	}

	private refreshPalette(): void {
		const key =
			(["border", "bashMode", "dim", "text", "muted"] as const).map((name) => theme.getFgAnsi(name)).join("") +
			theme.getColorMode() +
			isLightTheme();
		if (key === this.paletteKey) return;
		const colors = getResolvedThemeColors();
		const mode = theme.getColorMode();
		const ramp = (from: string, to: string): string[] =>
			Array.from({ length: RAMP_STEPS + 1 }, (_, index) =>
				foregroundAnsi(mixColors(parseColor(from), parseColor(to), index / RAMP_STEPS, "srgb"), mode),
			);
		this.borderRamp = ramp(colors.border, colors.bashMode);
		this.statusRamps = Array.from({ length: RAMP_STEPS + 1 }, (_, colorStep) => {
			const color = mixColors(
				parseColor(colors.border),
				parseColor(colors.bashMode),
				colorStep / RAMP_STEPS,
				"srgb",
			);
			const { l, c, h } = colorToOklch(color);
			const light = isLightTheme();
			const low = light ? l + (1 - l) * 0.24 : l * 0.72;
			const high = light ? l * 0.68 : Math.min(0.96, l + 0.12);
			return Array.from({ length: RAMP_STEPS + 1 }, (_, brightness) =>
				foregroundAnsi(oklchColor(low + ((high - low) * brightness) / RAMP_STEPS, c, h), mode),
			);
		});
		this.titleRamp = ramp(colors.dim, colors.bashMode);
		this.labelRamps = { text: ramp(colors.dim, colors.text), muted: ramp(colors.dim, colors.muted) };
		this.paletteKey = key;
	}

	private style(text: string, ink: Ink, colorStep: number): string {
		if (ink === "hidden") return text;
		const foreground = typeof ink === "number" ? this.statusRamps[colorStep][ink] : this.borderRamp[colorStep];
		const colored = `${foreground}${text}\x1b[39m`;
		if (ink === "dim") return `\x1b[2m${colored}\x1b[22m`;
		return colored;
	}
}
