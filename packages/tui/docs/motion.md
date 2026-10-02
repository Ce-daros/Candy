# Motion

Components own their visual path. Shared motion helpers own scheduled frames, progress, completion, and cancellation.

`MotionClock.start(interval, tick)` repeats a frame callback. `schedule(delay, tick)` schedules one callback. Either replaces the previous schedule. `stop()` cancels work, and `active` reports whether work is scheduled. Clocks are unreferenced so an animation cannot keep Node alive.

`MotionValue` animates between closed (`0`) and open (`1`) with smoothstep easing:

```typescript
const motion = new MotionValue(() => ui.requestRender(), { enter: 240, exit: 240 });
motion.setOptions(true, "moderate");
motion.setOpen(true);
const progress = motion.value();
```

`setOpen(open, onComplete?)` reverses from the current value and replaces the previous completion callback. `snap(value)` cancels pending work and establishes an immediate value. Disabling motion settles to the target and invokes the current completion. `dispose()` stops the clock and cancels completion without rendering. The owner must dispose motion when its component leaves the page.

`motionDuration()` scales durations by intensity: conservative `1.3`, moderate `1`, aggressive `0.75`. Callers can supply their existing factors. `smoothstep()` and `easeOutCubic()` clamp their input to `[0, 1]`.

These helpers do not own business deadlines, input debounce, asynchronous operations, or navigation. Keep those resources with their actual owner.
