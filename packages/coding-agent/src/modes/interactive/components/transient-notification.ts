import { type Component, foregroundAnsi, mixColors, truncateToWidth } from "@candy/tui";
import { theme } from "../theme/theme.ts";

export class TransientNotification implements Component {
	private text = "";
	private started = 0;
	private timer: NodeJS.Timeout | undefined;
	private readonly requestRender: () => void;
	private readonly animations: () => boolean;

	constructor(requestRender: () => void, animations: () => boolean) {
		this.requestRender = requestRender;
		this.animations = animations;
	}

	show(text: string): void {
		this.dispose();
		this.text = text;
		this.started = performance.now();
		this.timer = setInterval(() => {
			if (performance.now() - this.started >= 3400) this.clear();
			this.requestRender();
		}, 50);
		this.timer.unref();
		this.requestRender();
	}

	clear(): void {
		this.text = "";
		this.dispose();
	}
	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
	invalidate(): void {}

	render(width: number): string[] {
		if (!this.text) return [];
		const fade = this.animations() ? Math.max(0, Math.min(1, (performance.now() - this.started - 3000) / 400)) : 0;
		return [
			`${foregroundAnsi(mixColors(theme.colors.muted, theme.colors.dim, fade), theme.getColorMode())}${truncateToWidth(` ${this.text.replace(/\s*\n\s*/g, " ")}`, width, "…")}\x1b[39m`,
		];
	}
}
