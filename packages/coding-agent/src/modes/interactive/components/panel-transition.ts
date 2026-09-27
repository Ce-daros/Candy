import type { AnimationIntensity } from "../../../core/settings-manager.ts";

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

	constructor(render: () => void) {
		this.render = render;
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
		if (target === this.target) return;
		this.from = this.value();
		this.target = target;
		this.started = performance.now();
		this.onComplete = onComplete;
		const factor = this.intensity === "conservative" ? 1.3 : this.intensity === "aggressive" ? 0.75 : 1;
		this.duration = this.enabled ? (open ? 800 : 560) * Math.abs(target - this.from) * factor : 0;
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
