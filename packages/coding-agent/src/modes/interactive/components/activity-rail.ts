import { foregroundAnsi, mixColors } from "@candy/tui";
import { type ThemeColor, theme } from "../theme/theme.ts";

export function activityInk(color: ThemeColor, text: string, progress = 1): string {
	if (progress === 1) return theme.fg(color, text);
	if (progress === 0) return " ".repeat(text.length);
	return `${foregroundAnsi(mixColors(theme.colors.toolPendingBg, theme.colors[color], progress), theme.getColorMode())}${text}\x1b[39m`;
}

export function activityRail(padding = 0, progress = 1): string {
	return " ".repeat(padding) + activityInk("borderMuted", "│", progress);
}
