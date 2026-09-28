import type { AnimationIntensity } from "../../../core/settings-manager.ts";

function clamp(value: number): number {
	return Math.max(0, Math.min(1, value));
}

export function panelPhase(progress: number): { expanded: boolean; growth: number; topReveal: number } {
	return {
		expanded: progress > 0.12,
		growth: clamp((progress - 0.12) / 0.55),
		topReveal: progress < 0.12 ? 1 - progress / 0.12 : clamp((progress - 0.65) / 0.08),
	};
}

export function panelRowVisible(progress: number, row: number, total: number, revealStart: number): boolean {
	return progress >= revealStart + (row / Math.max(1, total)) * 0.25;
}

export class PanelTransition {
	private from = 0;
	private target = 0;
	private started = 0;
	private duration = 0;
	private timer: NodeJS.Timeout | undefined;
	private enabled = true;
	private intensity: AnimationIntensity = "moderate";
	private readonly render: () => void;
	private onComplete: (() => void) | undefined;
	private readonly timing: { enter: number; exit: number };

	constructor(render: () => void, timing = { enter: 800, exit: 560 }) {
		this.render = render;
		this.timing = timing;
	}

	value(): number {
		if (this.duration === 0) return this.target;
		const progress = Math.min(1, (performance.now() - this.started) / this.duration);
		const eased = progress * progress * (3 - 2 * progress);
		return this.from + (this.target - this.from) * eased;
	}

	setOptions(enabled: boolean, intensity: AnimationIntensity): void {
		this.enabled = enabled;
		this.intensity = intensity;
		if (!enabled) this.finish();
	}

	setOpen(open: boolean, onComplete?: () => void): void {
		const target = open ? 1 : 0;
		if (target === this.target) {
			if (onComplete) {
				if (this.duration === 0) onComplete();
				else this.onComplete = onComplete;
			}
			return;
		}
		this.from = this.value();
		this.target = target;
		this.started = performance.now();
		this.onComplete = onComplete;
		const factor = this.intensity === "conservative" ? 1.3 : this.intensity === "aggressive" ? 0.75 : 1;
		this.duration = this.enabled
			? (open ? this.timing.enter : this.timing.exit) * Math.abs(target - this.from) * factor
			: 0;
		if (this.timer) clearInterval(this.timer);
		if (this.duration === 0) {
			this.finish();
			return;
		}
		this.timer = setInterval(() => {
			if (performance.now() - this.started >= this.duration) this.finish();
			else this.render();
		}, 24);
		this.timer.unref();
		this.render();
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.onComplete = undefined;
	}

	private finish(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.duration = 0;
		const complete = this.onComplete;
		this.onComplete = undefined;
		complete?.();
		this.render();
	}
}
