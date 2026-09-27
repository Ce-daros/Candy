import { cliThemeColor } from "../modes/interactive/theme/theme.ts";

const emittedDeprecationWarnings = new Set<string>();

export function warnDeprecation(message: string): void {
	if (emittedDeprecationWarnings.has(message)) return;
	emittedDeprecationWarnings.add(message);
	console.warn(cliThemeColor("warning", `Deprecation warning: ${message}`));
}

/** Clear deprecation warning state. Exported for tests. */
export function clearDeprecationWarningsForTests(): void {
	emittedDeprecationWarnings.clear();
}
