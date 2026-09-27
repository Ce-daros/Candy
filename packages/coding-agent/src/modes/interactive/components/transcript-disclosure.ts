import { Box, Markdown, type MarkdownTheme, type TuiMouseEvent, truncateToWidth, visibleWidth } from "@candy/tui";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { theme } from "../theme/theme.ts";

export class TranscriptDisclosure extends Box {
	private expanded = false;
	private readonly body: Markdown;
	private readonly title: string;
	private readonly summary: string;
	private readonly variant: "rule" | "skill";
	private readonly source?: string;

	constructor(
		title: string,
		summary: string,
		body: string,
		markdownTheme: MarkdownTheme,
		variant: "rule" | "skill",
		source?: string,
	) {
		super(0, 0);
		this.title = title;
		this.summary = summary;
		this.variant = variant;
		this.source = source;
		this.body = new Markdown(
			body,
			0,
			0,
			markdownTheme,
			{
				color: (text: string) => theme.fg("customMessageText", text),
			},
			{
				onCopyCode: (code) => {
					void copyToClipboard(code);
				},
			},
		);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	override invalidate(): void {
		this.body.invalidate();
	}

	override render(width: number): string[] {
		const left = this.variant === "rule" ? theme.fg("borderMuted", "── ") : " ";
		const arrow = this.expanded ? "▾" : "▸";
		const title = theme.fg("customMessageLabel", theme.bold(`${arrow} ${this.title}`));
		const meta = this.summary ? theme.fg("dim", `  ${this.summary}`) : "";
		const prefix = `${left}${title}${meta}`;
		const tail =
			this.variant === "rule"
				? theme.fg("borderMuted", ` ${"─".repeat(Math.max(0, width - visibleWidth(prefix) - 1))}`)
				: "";
		const lines = [truncateToWidth(prefix + tail, width, "…")];
		if (!this.expanded) return lines;

		if (this.source) lines.push(truncateToWidth(theme.fg("dim", `   ${this.source}`), width, "…"));
		const rail = this.variant === "skill" ? theme.fg("customMessageLabel", "│") : theme.fg("borderMuted", "│");
		lines.push(...this.body.render(Math.max(1, width - 4)).map((line) => ` ${rail}  ${line}`));
		return lines;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Box["handleMouse"]> {
		if (event.type === "click" && event.button === "left" && event.y === 0) {
			this.expanded = !this.expanded;
			return {
				handled: true,
				target: {
					component: this,
					originX: event.screenX - event.x,
					originY: event.screenY - event.y,
					width: event.width,
					height: event.height,
				},
			};
		}
		const bodyStart = this.source ? 2 : 1;
		if (!this.expanded || event.y < bodyStart || event.x < 4) return undefined;
		const result = this.body.handleMouse({
			...event,
			x: event.x - 4,
			y: event.y - bodyStart,
			width: Math.max(1, event.width - 4),
		});
		if (!result?.handled) return undefined;
		return {
			...result,
			handled: true,
			target: {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		};
	}
}
