import { detectCapabilities, getTerminalColorMode } from "@candy/tui";
import type { ResourceThemeAdapter } from "../core/resource-loader.ts";
import { loadThemeFromPath } from "../modes/interactive/theme/theme.ts";

export const resourceThemeAdapter: ResourceThemeAdapter = {
	getTerminalColorMode: (overrides) =>
		getTerminalColorMode({
			...detectCapabilities(() => false),
			...overrides,
		}),
	loadThemeFromPath,
};
