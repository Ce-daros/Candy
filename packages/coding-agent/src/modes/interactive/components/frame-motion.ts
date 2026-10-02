import type { ThinkingLevel } from "@candy/agent-core";
import {
	type Color,
	colorToOklch,
	foregroundAnsi,
	MotionClock,
	mixColors,
	oklchColor,
	smoothstep,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@candy/tui";
import type { AnimationIntensity } from "../../../core/settings-manager.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import type { StatusIndicatorKind } from "./status-indicator.ts";

export type InputMode = "normal" | "shell" | "shell-no-context" | "command" | "help";

const TIMING: Record<AnimationIntensity, { entrance: number; transition: number; frame: number; status: number }> = {
	conservative: { entrance: 700, transition: 480, frame: 45, status: 150 },
	moderate: { entrance: 520, transition: 360, frame: 24, status: 90 },
	aggressive: { entrance: 350, transition: 240, frame: 16, status: 55 },
};

const RAMP_STEPS = 8;
const GRADIENT_STEPS = 48;
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_COLORS: Record<ThinkingLevel, ThemeColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

export function thinkingMeter(level: ThinkingLevel): string {
	const filled = THINKING_LEVELS.indexOf(level);
	return "▰".repeat(filled) + "▱".repeat(6 - filled);
}

interface Transition {
	from: InputMode;
	to: InputMode;
	start: number;
	previous?: { transition: Transition; at: number };
}

type Ink = "hidden" | "base" | "dim" | number;

const MODE_STEPS = RAMP_STEPS * 3;

function modeStep(mode: InputMode): number {
	return mode === "normal"
		? 0
		: mode === "shell" || mode === "shell-no-context"
			? RAMP_STEPS
			: mode === "command"
				? RAMP_STEPS * 2
				: MODE_STEPS;
}

function modeTitle(mode: InputMode): string {
	return mode === "shell-no-context"
		? "Shell · No Context"
		: mode === "shell"
			? "Shell"
			: mode === "command"
				? "Command"
				: mode === "help"
					? "Help"
					: "";
}

/** The border's geometry, mode color, and activity highlights share one clock. */
export class FrameMotion {
	private readonly ui: TUI;
	private enabled = true;
	private intensity: AnimationIntensity = "moderate";
	private mode: InputMode = "normal";
	private transition: Transition | undefined;
	private entranceStart: number | undefined;
	private entrancePending = true;
	private status: StatusIndicatorKind | undefined;
	private statusStart = 0;
	private thinking: ThinkingLevel = "off";
	private effortPulseStart = -Infinity;
	private readonly clock = new MotionClock();
	private paletteKey = "";
	private borderRamp: string[] = [];
	private statusRamps: string[][] = [];
	private titleRamps: Record<"shell" | "command" | "help", string[]> = { shell: [], command: [], help: [] };
	private labelRamps: Record<"text" | "muted" | "accent", string[]> = { text: [], muted: [], accent: [] };
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

	setMode(mode: InputMode): void {
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

	getMode(): InputMode {
		return this.mode;
	}

	getModeTitle(): string {
		const mode =
			this.mode === "normal" || (this.mode === "shell" && this.transition?.from === "shell-no-context")
				? (this.transition?.from ?? this.mode)
				: this.mode;
		return modeTitle(mode);
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

	setThinking(level: ThinkingLevel, pulse = false): void {
		this.thinking = level;
		if (pulse && this.enabled) this.effortPulseStart = performance.now();
		this.startTimer();
		this.ui.requestRender();
	}

	getThinking(): ThinkingLevel {
		return this.thinking;
	}

	paintThinking(text: string): string {
		this.refreshPalette();
		const now = performance.now();
		return `${Array.from(text, (char, index) => {
			const color = this.gradientAt(this.rightAnchor + index, this.rows - 1, now) * (MODE_STEPS + 1);
			return `${this.borderRamp[color]}${char}`;
		}).join("")}\x1b[39m`;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	getLabelPhase(): number {
		if (!this.enabled) return RAMP_STEPS;
		const p = Math.min(1, this.entranceProgress() / 0.8);
		return Math.min(RAMP_STEPS, Math.floor(p * (RAMP_STEPS + 1)));
	}

	paintLabel(text: string, color: "text" | "muted" | "accent"): string {
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
			const color = this.gradientAt(column, row, now) * (MODE_STEPS + 1) + this.colorAt(column, row, now);
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
		if (!this.enabled)
			return theme.fg(
				this.mode === "normal"
					? "border"
					: this.mode === "help"
						? "borderAccent"
						: this.mode === "command"
							? "accent"
							: "bashMode",
				text,
			);
		this.refreshPalette();
		const progress = this.getTitleProgress();
		const exiting = this.mode === "normal" && this.transition !== undefined && this.transition.from !== "normal";
		const width = visibleWidth(text);
		const visible = exiting
			? Math.ceil(width * (1 - progress))
			: this.transition?.from === "shell-no-context" && this.mode === "shell"
				? Math.min(width, Math.max(5, Math.ceil(width * (1 - progress))))
				: this.transition?.from === "shell" && this.mode === "shell-no-context"
					? Math.min(width, Math.max(5, Math.ceil(width * progress)))
					: width;
		const shown = truncateToWidth(text, visible, "");
		const rest = " ".repeat(width - visibleWidth(shown));
		const titleStep = Math.max(1, Math.round((exiting ? 1 - progress : progress) * RAMP_STEPS));
		const titleMode = exiting ? this.transition!.from : this.mode;
		const ramp =
			titleMode === "help"
				? this.titleRamps.help
				: titleMode === "command"
					? this.titleRamps.command
					: this.titleRamps.shell;
		return `${ramp[titleStep]}${shown}\x1b[39m${rest}`;
	}

	dispose(): void {
		this.clock.stop();
	}

	private startTimer(): void {
		this.clock.stop();
		if (!this.enabled) return;
		if (this.entrancePending && !this.transition) return;
		const breathing = this.thinking !== "off";
		const pulsing = performance.now() - this.effortPulseStart < 900;
		if (!this.status && !this.transition && this.entranceProgress() >= 1 && !breathing && !pulsing) return;
		const activeTransition = this.transition || this.entranceProgress() < 1;
		this.clock.schedule(TIMING[this.intensity][activeTransition ? "frame" : "status"], () => {
			if (this.transition && this.getTitleProgress() >= 1) this.transition = undefined;
			this.ui.requestRender();
			this.startTimer();
		});
	}

	private entranceProgress(): number {
		if (this.entranceStart === undefined) return 0;
		return smoothstep((performance.now() - this.entranceStart) / TIMING[this.intensity].entrance);
	}

	private colorAt(column: number, row: number, now: number): number {
		const transition = this.transition;
		if (!transition) return modeStep(this.mode);
		return this.transitionColorAt(transition, column, row, now);
	}

	private transitionColorAt(transition: Transition, column: number, row: number, now: number): number {
		const progress = smoothstep((now - transition.start) / TIMING[this.intensity].transition);
		const before = modeStep(transition.from);
		const after = modeStep(transition.to);
		if (before === after) return after;
		const initial = transition.previous
			? this.transitionColorAt(transition.previous.transition, column, row, transition.previous.at)
			: before;
		if (after > before) {
			const distance = this.distanceFromTitle(column, row, transition.to);
			const maximum = this.width / 2 + this.rows + this.width / 2;
			const reveal = smoothstep((progress - (distance / maximum) * 0.5) / 0.5);
			return Math.round(initial + (after - initial) * reveal);
		}
		const retract = smoothstep((progress - this.exitFraction(column, row, transition.from) * 0.5) / 0.5);
		return Math.round(initial + (after - initial) * retract);
	}

	private inkAt(column: number, row: number, now: number): Ink {
		const entranceInk = this.enabled ? this.entranceInkAt(column, row) : "base";
		if (entranceInk !== "base") return entranceInk;
		if (!this.enabled) return "base";
		const perimeter = Math.max(1, this.width * 2 + (this.rows - 2) * 2);
		const index = this.perimeterIndex(column, row);
		const level = THINKING_LEVELS.indexOf(this.thinking);
		const pulse = (now - this.effortPulseStart) / 900;
		if (pulse < 1) {
			const origin = this.perimeterIndex(this.rightAnchor, this.rows - 1);
			const distance = Math.min((index - origin + perimeter) % perimeter, (origin - index + perimeter) % perimeter);
			const wave = Math.abs(distance / (perimeter / 2) - pulse);
			if (wave < 0.15) return Math.round((1 - wave / 0.15) * RAMP_STEPS);
		}
		const breath = level === 0 ? 0 : Math.round((1 + Math.sin(now / (1700 - level * 100))) * (0.6 + level * 0.48));
		if (!this.status) return breath === 0 ? "base" : breath;
		const phase = (now - this.statusStart) / TIMING[this.intensity].status;
		const trail = Math.max(8, this.width * 0.1) * (0.7 + level * 0.35);
		const peak = Math.min(RAMP_STEPS, 4 + level);
		let distance: number;
		if (this.status === "working") {
			const beams = Math.max(1, level);
			const head = (phase * (2 + level)) % perimeter;
			distance = perimeter;
			for (let beam = 0; beam < beams; beam++) {
				distance = Math.min(distance, (head + (beam * perimeter) / beams - index + perimeter) % perimeter);
			}
		} else if (this.status === "retry") {
			const head = (phase * 7 + (phase % 4 === 0 ? 5 : 0)) % perimeter;
			distance = (head - index + perimeter) % perimeter;
		} else {
			const half = Math.floor(perimeter / 2);
			const head = (phase * 3) % half;
			distance = Math.min(Math.abs(index - head), Math.abs(index - (perimeter - head)));
		}
		return Math.max(breath, Math.round((1 - distance / trail) * peak));
	}

	private gradientAt(column: number, row: number, now: number): number {
		if (THINKING_LEVELS.indexOf(this.thinking) < 5) return 0;
		const perimeter = Math.max(1, this.width * 2 + (this.rows - 2) * 2);
		const flow = this.enabled ? now / (this.thinking === "max" ? 8000 : 12000) : 0;
		return Math.floor(((this.perimeterIndex(column, row) / perimeter + flow) % 1) * GRADIENT_STEPS);
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

	private distanceFromTitle(column: number, row: number, mode: InputMode): number {
		const center = 8 + Math.floor(modeTitle(mode).length / 2);
		if (row === 0) return Math.abs(column - center);
		if (column === 0) return center + row;
		if (column === this.width - 1) return this.width - 1 - center + row;
		return Math.min(
			center + this.rows - 1 + column,
			this.width - 1 - center + this.rows - 1 + this.width - 1 - column,
		);
	}

	private exitFraction(column: number, row: number, from: InputMode): number {
		const bottom = this.rows - 1;
		const titleEnd = Math.min(this.width - 1, 9 + modeTitle(from).length);
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
			(
				[
					"thinkingOff",
					"thinkingMinimal",
					"thinkingLow",
					"thinkingMedium",
					"thinkingHigh",
					"thinkingXhigh",
					"thinkingMax",
					"bashMode",
					"dim",
					"text",
					"muted",
					"accent",
					"borderAccent",
				] as const
			)
				.map((name) => theme.getFgAnsi(name))
				.join("") +
			theme.getColorMode() +
			theme.appearance +
			this.thinking;
		if (key === this.paletteKey) return;
		const colors = theme.colors;
		const mode = theme.getColorMode();
		const ramp = (from: Color, to: Color): string[] =>
			Array.from({ length: RAMP_STEPS + 1 }, (_, index) =>
				foregroundAnsi(mixColors(from, to, index / RAMP_STEPS, "srgb"), mode),
			);
		const light = theme.appearance === "light";
		const level = THINKING_LEVELS.indexOf(this.thinking);
		const base = colors[THINKING_COLORS[this.thinking]];
		const stops = [
			colors.thinkingHigh,
			colors.thinkingLow,
			colors.thinkingMedium,
			colors.accent,
			colors.thinkingHigh,
			base,
		];
		const gradient = Array.from({ length: level >= 5 ? GRADIENT_STEPS : 1 }, (_, index) => {
			if (level < 5) return base;
			const position = (index / GRADIENT_STEPS) * stops.length;
			const mixed = mixColors(
				stops[Math.floor(position)],
				stops[(Math.floor(position) + 1) % stops.length],
				position % 1,
				"oklch",
			);
			const { l, c, h } = colorToOklch(mixed);
			const target = colorToOklch(base).l;
			return oklchColor(light ? Math.min(l, target) : Math.max(l, target), c, h);
		});
		const palette = gradient.flatMap((color) => [
			...Array.from({ length: RAMP_STEPS + 1 }, (_, index) =>
				mixColors(color, colors.bashMode, index / RAMP_STEPS, "srgb"),
			),
			...Array.from({ length: RAMP_STEPS }, (_, index) =>
				mixColors(colors.bashMode, colors.accent, (index + 1) / RAMP_STEPS, "srgb"),
			),
			...Array.from({ length: RAMP_STEPS }, (_, index) =>
				mixColors(colors.accent, colors.borderAccent, (index + 1) / RAMP_STEPS, "srgb"),
			),
		]);
		this.borderRamp = palette.map((color) => foregroundAnsi(color, mode));
		this.statusRamps = palette.map((color) => {
			const { l, c, h } = colorToOklch(color);
			const high = light ? l * (0.7 - level * 0.035) : Math.min(0.99, l + 0.15 + level * 0.035);
			return Array.from({ length: RAMP_STEPS + 1 }, (_, brightness) =>
				foregroundAnsi(oklchColor(l + ((high - l) * brightness) / RAMP_STEPS, c * (1 - brightness / 16), h), mode),
			);
		});
		this.titleRamps = {
			shell: ramp(colors.dim, colors.bashMode),
			command: ramp(colors.dim, colors.accent),
			help: ramp(colors.dim, colors.borderAccent),
		};
		this.labelRamps = {
			text: ramp(colors.dim, colors.text),
			muted: ramp(colors.dim, colors.muted),
			accent: ramp(colors.dim, colors.accent),
		};
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
