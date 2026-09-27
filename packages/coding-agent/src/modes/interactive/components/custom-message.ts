import type { TextContent } from "@candy/ai";
import type { Component } from "@candy/tui";
import { Container, Markdown, type MarkdownTheme, Spacer, Text, type TuiMouseEvent } from "@candy/tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private box: Container;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;
	private outputPad: number;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;

		this.addChild(new Spacer(1));

		this.box = new Container();

		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	setOutputPad(outputPad: number): void {
		if (this.outputPad !== outputPad) {
			this.outputPad = outputPad;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		// Remove previous content component
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		this.removeChild(this.box);

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(
					this.message,
					{ expanded: this._expanded, outputPad: this.outputPad },
					theme,
				);
				if (component) {
					// Custom renderer provides its own styled component
					this.customComponent = component;
					this.addChild(component);
					return;
				}
			} catch {
				// Fall through to default rendering
			}
		}

		// Default rendering uses a title and a quiet rail; custom renderers own their presentation.
		this.addChild(this.box);
		this.box.clear();

		// Default rendering: label + content
		const label = theme.fg("customMessageLabel", theme.bold(this.message.customType));
		this.box.addChild(new Text(` ${label}`, 0, 0));

		// Extract text content
		let text: string;
		if (typeof this.message.content === "string") {
			text = this.message.content;
		} else {
			text = this.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}

		const markdown = new Markdown(
			text,
			0,
			0,
			this.markdownTheme,
			{
				color: (text: string) => theme.fg("customMessageText", text),
			},
			{
				onCopyCode: (code) => {
					void copyToClipboard(code);
				},
			},
		);
		this.box.addChild({
			render: (width: number) =>
				markdown.render(Math.max(1, width - 4)).map((line) => ` ${theme.fg("customMessageLabel", "│")}  ${line}`),
			invalidate: () => markdown.invalidate(),
			handleMouse: (event: TuiMouseEvent) =>
				event.x < 4
					? undefined
					: markdown.handleMouse({
							...event,
							x: event.x - 4,
							width: Math.max(1, event.width - 4),
						}),
		});
	}
}
