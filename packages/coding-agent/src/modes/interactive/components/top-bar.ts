import { type Component, truncateToWidth, visibleWidth } from "@candy/tui";
import { theme } from "../theme/theme.ts";

export interface TopBarData {
	/** Project directory name shown after the app title. */
	readonly project: string;
	/** Current git branch, null when not in a repository. */
	readonly branch: string | null;
	/** Session display name, undefined when unnamed. */
	readonly sessionName: string | undefined;
	readonly contextPercent: number | null;
}

const TITLE = "Candy";
const SEPARATOR = " ─ ";

/**
 * Fixed fullscreen title bar. The line after the workspace identity grows
 * with context usage within the space left by the identity and session name.
 */
export class TopBarComponent implements Component {
	private readonly getData: () => TopBarData;

	constructor(getData: () => TopBarData) {
		this.getData = getData;
	}

	invalidate(): void {
		// Data is read at render time; nothing to invalidate.
	}

	render(width: number): string[] {
		const { project, branch, sessionName, contextPercent } = this.getData();
		const left = branch ? `${project}/${branch}` : project;
		const suffix = sessionName ? ` ${sessionName}` : "";

		const titleText = truncateToWidth(TITLE, width, "");
		const separatorText = truncateToWidth(SEPARATOR, Math.max(0, width - visibleWidth(titleText)), "");
		const maxLeftWidth = Math.max(0, width - visibleWidth(titleText) - visibleWidth(separatorText));
		const leftText = truncateToWidth(left, maxLeftWidth, "…");
		const identityWidth = visibleWidth(titleText) + visibleWidth(separatorText) + visibleWidth(leftText);
		const available = Math.max(0, width - identityWidth);
		const suffixText = available > 1 ? truncateToWidth(suffix, Math.max(0, available - 2), "…") : "";
		const lineSpace = Math.max(0, available - visibleWidth(suffixText));
		const prefix = lineSpace > 0 ? " " : "";
		const maxLineWidth = lineSpace - prefix.length;
		const lineWidth =
			contextPercent === null ? 0 : Math.round((Math.max(0, Math.min(100, contextPercent)) / 100) * maxLineWidth);
		const fillWidth = Math.max(0, lineSpace - prefix.length - lineWidth);

		const parts = [theme.fg("accent", titleText), theme.fg("dim", separatorText)];
		if (leftText) parts.push(theme.fg("muted", leftText));
		if (prefix) parts.push(theme.fg("dim", prefix));
		if (lineWidth > 0) parts.push(theme.fg("dim", "─".repeat(lineWidth)));
		if (fillWidth > 0) parts.push(" ".repeat(fillWidth));
		if (suffixText) parts.push(theme.fg("dim", suffixText));
		return [parts.join("")];
	}
}
