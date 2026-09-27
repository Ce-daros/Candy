import { type Component, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth } from "@candy/tui";
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

export class LoadedResourcesComponent implements Component {
	private sections: readonly LoadedResourceSection[];
	private expanded: boolean;

	constructor(sections: readonly LoadedResourceSection[], expanded = false) {
		this.sections = sections;
		this.expanded = expanded;
	}

	setSections(sections: readonly LoadedResourceSection[]): void {
		this.sections = sections;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	getExpanded(): boolean {
		return this.expanded;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const count = this.sections.reduce((sum, section) => sum + section.entries.length, 0);
		const counts = this.sections
			.map((section) => `${section.entries.length} ${section.name.toLocaleLowerCase()}`)
			.join(" · ");
		const heading = `${this.expanded ? "▾" : "▸"} Loaded resources · ${count}${counts ? `  ${counts}` : ""}`;
		const lines = [truncateToWidth(theme.fg("accent", heading), width)];
		if (!this.expanded) return lines;
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

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
		this.expanded = !this.expanded;
		return { handled: true, render: true };
	}
}
