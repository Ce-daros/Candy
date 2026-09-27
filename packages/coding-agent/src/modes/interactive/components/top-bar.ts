import { type Component, foregroundAnsi, mixColors, truncateToWidth, visibleWidth } from "@candy/tui";
import { type ThemeColor, theme } from "../theme/theme.ts";

export interface TopBarData {
	readonly project: string;
	readonly branch: string | null;
	readonly sessionName: string | undefined;
	readonly contextPercent: number | null;
}

export class TopBarComponent implements Component {
	private readonly getData: () => TopBarData;
	private readonly requestRender: (() => void) | undefined;
	private percent: number | null = null;
	private changedAt = -Infinity;
	private animations = true;
	private timer: NodeJS.Timeout | undefined;

	constructor(getData: () => TopBarData, requestRender?: () => void) {
		this.getData = getData;
		this.requestRender = requestRender;
	}

	setAnimations(enabled: boolean): void {
		this.animations = enabled;
		this.updateTimer();
	}

	invalidate(): void {}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private updateTimer(): void {
		const needsTimer =
			this.requestRender &&
			this.percent !== null &&
			((this.percent < 30 && performance.now() - this.changedAt < 2400) || (this.animations && this.percent >= 70));
		if (!needsTimer) this.dispose();
		else if (!this.timer) {
			this.timer = setInterval(() => {
				this.requestRender?.();
				this.updateTimer();
			}, 60);
			this.timer.unref();
		}
	}

	render(width: number): string[] {
		const { project, branch, sessionName, contextPercent } = this.getData();
		if (contextPercent !== this.percent) {
			this.percent = contextPercent;
			this.changedAt = performance.now();
			this.updateTimer();
		}
		const title = truncateToWidth("Candy ─ ", width, "");
		const identity = truncateToWidth(
			branch ? `${project}/${branch}` : project,
			Math.max(0, width - visibleWidth(title)),
			"…",
		);
		const remaining = Math.max(0, width - visibleWidth(title) - visibleWidth(identity));
		const suffix = sessionName
			? truncateToWidth(` ${sessionName}`, Math.max(0, Math.floor(remaining * 0.35)), "…")
			: "";
		const meterWidth = Math.max(0, remaining - visibleWidth(suffix));
		const percent = contextPercent === null ? 0 : Math.max(0, Math.min(100, contextPercent));
		const lineWidth = Math.max(0, meterWidth - 7);
		const occupied = contextPercent === null ? 0 : Math.round((lineWidth * percent) / 100);
		const age = performance.now() - this.changedAt;
		const visible = contextPercent !== null && (percent >= 30 || age < 2400);
		const fade = this.animations && percent < 30 ? Math.min(1, Math.max(0, (age - 2000) / 400)) : 0;
		const role: ThemeColor =
			percent >= 95
				? "error"
				: percent >= 85
					? "accent"
					: percent >= 70
						? "thinkingMedium"
						: percent >= 50
							? "warning"
							: "muted";
		const phase = (performance.now() % (percent >= 85 ? 2600 : 6000)) / (percent >= 85 ? 2600 : 6000);
		const paint = (text: string, position: number, baseline: ThemeColor): string => {
			const wave =
				this.animations && percent >= 70
					? Math.max(
							0,
							1 - Math.abs(position / Math.max(1, lineWidth + 5) - phase * 1.5) * (percent >= 85 ? 6 : 12),
						)
					: 0;
			const strength = percent >= 95 ? 0.25 + wave * 0.7 : wave * 0.85;
			const color = mixColors(theme.colors[baseline], theme.colors[role], strength);
			return `${foregroundAnsi(mixColors(color, theme.colors.dim, fade), theme.getColorMode())}${text}\x1b[39m`;
		};
		let meter = meterWidth > 0 ? " " : "";
		for (let index = 0; index < lineWidth; index++) meter += index < occupied ? paint("─", index, "dim") : " ";
		if (meterWidth >= 7)
			meter += visible ? ` ${paint(`${Math.round(percent)}%`.padStart(4), lineWidth + 3, role)} ` : "      ";
		meter += " ".repeat(Math.max(0, meterWidth - visibleWidth(meter)));
		return [
			truncateToWidth(
				theme.fg("accent", title) + theme.fg("muted", identity) + meter + theme.fg("dim", suffix),
				width,
				"",
			),
		];
	}
}
