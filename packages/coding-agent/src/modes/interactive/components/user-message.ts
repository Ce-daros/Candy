import { Container, Markdown, type MarkdownTheme, type TuiMouseEvent, truncateToWidth } from "@candy/tui";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const PREVIEW_LINES = 8;

export class UserMessageComponent extends Container {
	private readonly text: string;
	private readonly markdownTheme: MarkdownTheme;
	private outputPad: number;
	private expanded = false;
	private markdown: Markdown;
	private collapsed = false;
	private renderedHeight = 0;
	private renderedWidth = 0;

	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdown = this.createMarkdown();
	}

	private createMarkdown(): Markdown {
		return new Markdown(
			this.text,
			0,
			0,
			this.markdownTheme,
			{
				color: (content: string) => theme.fg("userMessageText", content),
			},
			{
				preserveOrderedListMarkers: true,
				preserveBackslashEscapes: true,
				onCopyCode: (code) => {
					void copyToClipboard(code);
				},
			},
		);
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.markdown = this.createMarkdown();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	override invalidate(): void {
		this.markdown.invalidate();
	}

	override render(width: number): string[] {
		const indent = this.outputPad + 2;
		const contentWidth = Math.max(1, width - indent);
		const body = this.markdown.render(contentWidth);
		if (body.length === 0) return [];

		this.collapsed = !this.expanded && body.length > PREVIEW_LINES;
		const visible = this.collapsed ? body.slice(0, PREVIEW_LINES) : body;
		const lines = visible.map(
			(line, index) => `${" ".repeat(this.outputPad)}${index === 0 ? theme.fg("editorPrompt", "◆ ") : "  "}${line}`,
		);
		if (this.collapsed) {
			const label = theme.fg("dim", `▾ ${body.length - PREVIEW_LINES} more lines`);
			lines.push(`${" ".repeat(indent)}${truncateToWidth(label, contentWidth, "…")}`);
		}
		this.renderedHeight = lines.length;
		this.renderedWidth = width;
		if (lines.length === 1) {
			lines[0] = `${OSC133_ZONE_START}${lines[0]}${OSC133_ZONE_END}${OSC133_ZONE_FINAL}\x1b[0m`;
		} else {
			lines[0] = OSC133_ZONE_START + lines[0];
			lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		}
		return lines;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const indent = this.outputPad + 2;
		if (
			(this.collapsed && event.y === this.renderedHeight - 1) ||
			(this.expanded && event.y === 0 && event.x < indent)
		) {
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
		if (event.x < indent || event.y >= (this.collapsed ? PREVIEW_LINES : this.renderedHeight)) return undefined;
		const result = this.markdown.handleMouse({
			...event,
			x: event.x - indent,
			width: Math.max(1, this.renderedWidth - indent),
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
