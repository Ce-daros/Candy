import { type Component, truncateToWidth, visibleWidth } from "@candy/tui";
import { theme } from "../theme/theme.ts";

export interface TopBarData {
	/** Project directory name shown after the app title. */
	readonly project: string;
	/** Current git branch, null when not in a repository. */
	readonly branch: string | null;
	/** Session display name, undefined when unnamed. */
	readonly sessionName: string | undefined;
}

const TITLE = "Candy";
const SEPARATOR = " ─ ";

/**
 * Fixed fullscreen title bar: `Candy ─ <project>/<branch> ───── <session>`.
 * The project/branch segment sits on the left, the session name on the right,
 * and a dash fill spans the remaining width.
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
		const { project, branch, sessionName } = this.getData();
		const left = branch ? `${project}/${branch}` : project;
		const suffix = sessionName ? ` ${sessionName}` : "";

		const maxLeftWidth = Math.max(0, width - visibleWidth(SEPARATOR) - TITLE.length - visibleWidth(suffix));
		const leftText = truncateToWidth(left, maxLeftWidth, "…");
		let line = `${TITLE}${SEPARATOR}${leftText}`;
		let suffixText = suffix;
		if (visibleWidth(line) + visibleWidth(suffix) > width) {
			suffixText = truncateToWidth(suffix, Math.max(0, width - visibleWidth(line)), "");
		}
		const fillWidth = Math.max(0, width - visibleWidth(line) - visibleWidth(suffixText));
		line += "─".repeat(fillWidth) + suffixText;

		const parts = [theme.fg("accent", TITLE), theme.fg("dim", SEPARATOR)];
		if (leftText) parts.push(theme.fg("muted", leftText));
		if (fillWidth > 0) parts.push(theme.fg("dim", "─".repeat(fillWidth)));
		if (suffixText) parts.push(theme.fg("dim", suffixText));
		return [parts.join("")];
	}
}
