import { describe, expect, test } from "vitest";
import { formatCrashExtensionHint } from "../src/modes/interactive/interactive-mode.ts";

describe("interactive extension error hints", () => {
	test("identifies extensions with frames in an error stack", () => {
		expect(formatCrashExtensionHint(["npm:pi-observational-memory"])).toBe(
			"A stack frame came from loaded extension `npm:pi-observational-memory`, which may be involved. Try disabling it with `candy config`, or run `candy -ne` to confirm.",
		);
		expect(formatCrashExtensionHint(undefined)).toBeUndefined();
	});
});
