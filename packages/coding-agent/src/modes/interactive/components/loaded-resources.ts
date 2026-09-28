import { type Component, truncateToWidth } from "@candy/tui";
import { theme } from "../theme/theme.ts";

export interface LoadedResourceEntry {
	name: string;
	path: string;
	source?: string;
}

export interface LoadedResourceSection {
	name: string;
	entries: readonly LoadedResourceEntry[];
}

/**
 * Static summary of the loaded skills, prompts, extensions, and themes.
 *
 * The detail state is fixed at construction (expanded by verbose startup) and
 * cannot be toggled from the transcript.
 */
export class LoadedResourcesComponent implements Component {
	private readonly sections: readonly LoadedResourceSection[];
	private readonly expanded: boolean;

	constructor(sections: readonly LoadedResourceSection[], expanded = false) {
		this.sections = sections;
		this.expanded = expanded;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.expanded) return [];
		const lines: string[] = [];
		for (const section of this.sections) {
			lines.push(theme.fg("customMessageLabel", `  ${section.name}  ${section.entries.length}`));
			for (const entry of section.entries) {
				lines.push(
					truncateToWidth(
						`    ${theme.fg("text", entry.name)}${entry.source ? theme.fg("muted", `  · ${entry.source}`) : ""}`,
						width,
					),
				);
				lines.push(truncateToWidth(theme.fg("dim", `      ${entry.path}`), width));
			}
		}
		return lines;
	}
}
