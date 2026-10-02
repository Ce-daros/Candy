import { type Component, foregroundAnsi, MotionClock, mixColors, truncateToWidth } from "@candy/tui";
import { theme } from "../theme/theme.ts";

export class TransientNotification implements Component {
	private text = "";
	private started = 0;
	private readonly clock = new MotionClock();
	private readonly requestRender: () => void;
	private readonly animations: () => boolean;
	private animated = false;

	constructor(requestRender: () => void, animations: () => boolean) {
		this.requestRender = requestRender;
		this.animations = animations;
	}

	show(text: string): void {
		this.dispose();
		this.text = text;
		this.started = performance.now();
		this.animated = this.animations();
		this.scheduleTick();
		this.requestRender();
	}

	private scheduleTick(): void {
		const remaining = Math.max(0, 3400 - (performance.now() - this.started));
		this.clock.schedule(this.animated ? Math.min(50, remaining) : remaining, () => {
			if (performance.now() - this.started >= 3400) this.clear();
			else this.scheduleTick();
			this.requestRender();
		});
	}

	clear(): void {
		this.text = "";
		this.dispose();
	}
	dispose(): void {
		this.clock.stop();
	}
	invalidate(): void {}

	render(width: number): string[] {
		if (!this.text) return [];
		if (this.animated !== this.animations()) {
			this.animated = this.animations();
			this.scheduleTick();
		}
		const fade = this.animations() ? Math.max(0, Math.min(1, (performance.now() - this.started - 3000) / 400)) : 0;
		return [
			`${foregroundAnsi(mixColors(theme.colors.muted, theme.colors.dim, fade), theme.getColorMode())}${truncateToWidth(` ${this.text.replace(/\s*\n\s*/g, " ")}`, width, "…")}\x1b[39m`,
		];
	}
}
