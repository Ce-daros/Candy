export type MotionIntensity = "conservative" | "moderate" | "aggressive";

export function motionDuration(
	duration: number,
	intensity: MotionIntensity,
	factors: Record<MotionIntensity, number> = { conservative: 1.3, moderate: 1, aggressive: 0.75 },
): number {
	return duration * factors[intensity];
}

export function smoothstep(value: number): number {
	const progress = Math.max(0, Math.min(1, value));
	return progress * progress * (3 - 2 * progress);
}

export function easeOutCubic(value: number): number {
	return 1 - (1 - Math.max(0, Math.min(1, value))) ** 3;
}

export class MotionClock {
	private timer: NodeJS.Timeout | undefined;

	get active(): boolean {
		return this.timer !== undefined;
	}

	schedule(delay: number, tick: () => void): void {
		this.stop();
		this.timer = setTimeout(() => {
			this.timer = undefined;
			tick();
		}, delay);
		this.timer.unref();
	}

	start(interval: number, tick: () => void): void {
		this.stop();
		this.timer = setInterval(tick, interval);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}

export class MotionValue {
	private from = 0;
	private target = 0;
	private started = 0;
	private duration = 0;
	private readonly clock = new MotionClock();
	private enabled = true;
	private intensity: MotionIntensity = "moderate";
	private readonly render: () => void;
	private onComplete: (() => void) | undefined;
	private readonly timing: { enter: number; exit: number };

	constructor(render: () => void, timing: { enter: number; exit: number }) {
		this.render = render;
		this.timing = timing;
	}

	get active(): boolean {
		return this.duration > 0;
	}

	value(): number {
		if (!this.active) return this.target;
		const progress = smoothstep((performance.now() - this.started) / this.duration);
		return this.from + (this.target - this.from) * progress;
	}

	setOptions(enabled: boolean, intensity: MotionIntensity): void {
		this.enabled = enabled;
		this.intensity = intensity;
		if (!enabled && this.active) this.finish();
	}

	snap(value: number): void {
		this.dispose();
		this.from = value;
		this.target = value;
	}

	setOpen(open: boolean, onComplete?: () => void): void {
		const target = open ? 1 : 0;
		if (target === this.target) {
			this.onComplete = onComplete;
			if (!this.active && onComplete) this.finish();
			return;
		}
		this.from = this.value();
		this.target = target;
		this.started = performance.now();
		this.onComplete = onComplete;
		this.duration = this.enabled
			? motionDuration(open ? this.timing.enter : this.timing.exit, this.intensity) * Math.abs(target - this.from)
			: 0;
		this.clock.stop();
		if (!this.active) {
			this.finish();
			return;
		}
		this.clock.start(24, () => {
			if (performance.now() - this.started >= this.duration) this.finish();
			else this.render();
		});
		this.render();
	}

	dispose(): void {
		this.clock.stop();
		this.duration = 0;
		this.onComplete = undefined;
	}

	private finish(): void {
		this.clock.stop();
		this.duration = 0;
		const complete = this.onComplete;
		this.onComplete = undefined;
		complete?.();
		this.render();
	}
}
