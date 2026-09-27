import {
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@candy/tui";
import { theme } from "../theme/theme.ts";

export class QueuedMessagesComponent implements Component {
	private messages: { text: string; type: "Steering" | "Follow-up" }[] = [];
	private expanded = false;
	private readonly restoreHint: string;

	constructor(steering: readonly string[], followUp: readonly string[], restoreHint: string) {
		this.messages = [
			...steering.map((text) => ({ text, type: "Steering" as const })),
			...followUp.map((text) => ({ text, type: "Follow-up" as const })),
		];
		this.restoreHint = restoreHint;
	}

	invalidate(): void {}
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || event.y !== 0) return;
		this.expanded = !this.expanded;
		return { handled: true, render: true };
	}

	render(width: number): string[] {
		if (this.messages.length === 0) return [];
		const title = `${this.expanded ? "▾" : "▸"} Queued ${this.messages.length}`;
		const lines = [theme.fg("accent", title)];
		for (const message of this.expanded ? this.messages : this.messages.slice(0, 3)) {
			const prefix = theme.fg(message.type === "Steering" ? "borderAccent" : "accent", `${message.type}  `);
			if (this.expanded) lines.push(...wrapTextWithAnsi(`  ${prefix}${message.text}`, width));
			else lines.push(truncateToWidth(`  ${prefix}${message.text.replace(/\s+/g, " ")}`, width, "…"));
		}
		lines.push(theme.fg("dim", `  ${this.restoreHint} to edit all`));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}
}
