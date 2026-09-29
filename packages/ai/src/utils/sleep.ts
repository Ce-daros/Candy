import { abortReason } from "./abort.ts";

/**
 * Wait `ms`, rejecting with the signal's abort reason when it aborts. Timers
 * never outlive the wait: the listener is removed before resolving.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));

	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(abortReason(signal));
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(abortReason(signal));
		};
		const timeout = setTimeout(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
			Math.max(0, ms),
		);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
