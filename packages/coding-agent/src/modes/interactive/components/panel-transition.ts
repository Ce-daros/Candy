import { MotionValue } from "@candy/tui";

export type PanelNavigation = "enter" | "back" | "replace";

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

export class PanelTransition extends MotionValue {
	constructor(render: () => void, timing = { enter: 800, exit: 560 }) {
		super(render, timing);
	}
}
