import { MotionClock, MotionValue } from "@candy/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelTransition } from "../src/modes/interactive/components/panel-transition.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("shared motion lifecycle", () => {
	it("reverses from the current value and cancels the previous completion", () => {
		const motion = new MotionValue(vi.fn(), { enter: 240, exit: 240 });
		const closed = vi.fn();
		motion.snap(1);
		motion.setOpen(false, closed);
		vi.advanceTimersByTime(96);
		const before = motion.value();
		motion.setOpen(true);
		expect(motion.value()).toBe(before);
		vi.advanceTimersByTime(240);
		expect(motion.value()).toBe(1);
		expect(closed).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["conservative", "moderate", "aggressive"] as const)(
		"finishes disabled motion immediately with %s intensity",
		(intensity) => {
			const motion = new MotionValue(vi.fn(), { enter: 240, exit: 240 });
			const complete = vi.fn();
			motion.setOptions(true, intensity);
			motion.setOpen(true, complete);
			vi.advanceTimersByTime(48);
			motion.setOptions(false, intensity);
			expect(motion.value()).toBe(1);
			expect(complete).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("releases scheduled and repeating work on disposal", () => {
		const clock = new MotionClock();
		const tick = vi.fn();
		clock.schedule(24, tick);
		clock.start(40, tick);
		vi.advanceTimersByTime(40);
		expect(tick).toHaveBeenCalledOnce();
		clock.stop();
		vi.advanceTimersByTime(200);
		expect(tick).toHaveBeenCalledOnce();
		const motion = new MotionValue(tick, { enter: 240, exit: 240 });
		const complete = vi.fn();
		motion.setOpen(true, complete);
		motion.dispose();
		vi.advanceTimersByTime(240);
		expect(complete).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("panel opening", () => {
	it("uses the existing 800ms entrance and 560ms exit", () => {
		const transition = new PanelTransition(vi.fn());
		transition.setOpen(true);
		vi.advanceTimersByTime(240);
		expect(transition.active).toBe(true);
		expect(transition.value()).toBeLessThan(1);
		vi.advanceTimersByTime(576);
		expect(transition.value()).toBe(1);
		const complete = vi.fn();
		transition.setOpen(false, complete);
		vi.advanceTimersByTime(240);
		expect(complete).not.toHaveBeenCalled();
		vi.advanceTimersByTime(336);
		expect(complete).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
});
