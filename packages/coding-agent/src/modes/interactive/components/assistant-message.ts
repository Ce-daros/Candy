import type { AssistantMessage, AssistantMessageEvent } from "@candy/ai";
import {
	type Component,
	Container,
	colorToOklch,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	oklchColor,
	Spacer,
	Text,
	type TuiMouseEvent,
	truncateToWidth,
} from "@candy/tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import type { AnimationIntensity } from "../../../core/settings-manager.ts";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { activityInk, activityRail } from "./activity-rail.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { PanelTransition } from "./panel-transition.ts";
import { TranscriptNotice } from "./transcript-notice.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const PROSE_WIDTH = 110;

class ThinkingRail implements Component {
	private readonly content: Markdown;
	private readonly padding: number;

	constructor(content: Markdown, padding: number) {
		this.content = content;
		this.padding = padding;
	}

	render(width: number): string[] {
		return this.content
			.render(Math.max(1, width - this.padding - 2))
			.map((line) => `${activityRail(this.padding)} ${line}`);
	}

	invalidate(): void {
		this.content.invalidate();
	}

	handleMouse(event: TuiMouseEvent) {
		const indent = this.padding + 2;
		if (event.x < indent) return undefined;
		return this.content.handleMouse({ ...event, x: event.x - indent, width: Math.max(1, event.width - indent) });
	}
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private codeBlockView?: (
		code: string,
		language: string | undefined,
		width: number,
		isStreaming: boolean,
		complete: boolean,
	) => string[] | undefined;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	private notices: TranscriptNotice[] = [];
	private expanded = false;
	private animations = false;
	private intensity: AnimationIntensity = "moderate";
	private requestRender: (() => void) | undefined;
	private breathingTimer: NodeJS.Timeout | undefined;
	private completedBlocks = new Set<number>();
	private entrances = new Map<number, PanelTransition>();
	private seenTextBlocks = new Set<number>();
	private stats: string | undefined;
	private statsExpanded = false;

	setStats(text: string): void {
		this.stats = text;
	}

	setAnimationOptions(enabled: boolean, intensity: AnimationIntensity, requestRender: () => void): void {
		this.animations = enabled;
		this.intensity = intensity;
		this.requestRender = requestRender;
		for (const transition of this.entrances.values()) transition.setOptions(enabled, intensity);
		this.syncBreathing();
	}

	private syncBreathing(): void {
		if (this.breathingTimer) clearInterval(this.breathingTimer);
		this.breathingTimer = undefined;
		if (!this.animations || !this.isStreaming) return;
		this.breathingTimer = setInterval(() => this.requestRender?.(), 40);
		this.breathingTimer.unref();
	}

	dispose(): void {
		if (this.breathingTimer) clearInterval(this.breathingTimer);
		this.breathingTimer = undefined;
		for (const transition of this.entrances.values()) transition.dispose();
		this.entrances.clear();
	}

	private marker(active: boolean, color: "text" | "thinkingText", entrance = 1): string {
		const period = this.intensity === "conservative" ? 1800 : this.intensity === "aggressive" ? 1000 : 1400;
		const wave = active && this.animations ? (1 - Math.cos((performance.now() / period) * Math.PI * 2)) / 2 : 1;
		return activityInk(color, active && (!this.animations || wave < 0.5) ? "✧" : "✦", entrance * (0.5 + wave * 0.5));
	}

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = true,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		codeBlockView?: (
			code: string,
			language: string | undefined,
			width: number,
			isStreaming: boolean,
			complete: boolean,
		) => string[] | undefined,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.codeBlockView = codeBlockView;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);
		this.addChild({
			render: (width) =>
				this.statsExpanded && this.stats
					? new Text(theme.fg("dim", this.stats), this.outputPad + 2, 0).render(width)
					: [],
			invalidate: () => {},
		});

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const notice of this.notices) notice.setExpanded(expanded);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming, event?: AssistantMessageEvent): void {
		if (event?.type === "thinking_end" || event?.type === "text_end") this.completedBlocks.add(event.contentIndex);
		const streamingChanged = this.isStreaming !== isStreaming;
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		if (streamingChanged) this.syncBreathing();

		// Clear content container
		this.contentContainer.clear();
		this.notices = [];

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		let thinkingRunIndex = 0;
		let hasPreviousBlock = false;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				const blockIndex = i;
				if (!this.seenTextBlocks.has(i)) {
					this.seenTextBlocks.add(i);
					if (this.isStreaming && this.requestRender) {
						const entrance = new PanelTransition(this.requestRender, { enter: 240, exit: 240 });
						entrance.setOptions(this.animations, this.intensity);
						entrance.setOpen(true);
						this.entrances.set(i, entrance);
					}
				}
				const progress = () => this.entrances.get(blockIndex)?.value() ?? 1;
				if (hasPreviousBlock)
					this.contentContainer.addChild({
						render: () => [activityRail(this.outputPad, progress())],
						invalidate: () => {},
					});
				const markdown = new Markdown(
					content.text.trim(),
					0,
					0,
					this.markdownTheme,
					{
						color: (text) => {
							const ink = colorToOklch(theme.colors.text);
							return theme.style(text, { fg: oklchColor(ink.l * 0.92, ink.c, ink.h) });
						},
					},
					{
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
						maxProseWidth: PROSE_WIDTH,
						codeBlockView: (code, language, width, complete) =>
							this.codeBlockView?.(code, language, width, this.isStreaming, complete),
						onCopyCode: (code) => {
							void copyToClipboard(code);
						},
					},
				);
				this.contentContainer.addChild({
					render: (width: number) =>
						markdown
							.render(Math.max(1, width - this.outputPad - 2))
							.map(
								(line, row) =>
									" ".repeat(this.outputPad) +
									(row === 0
										? `${this.marker(this.isStreaming && blockIndex === message.content.length - 1 && !this.completedBlocks.has(blockIndex), "text", progress())} `
										: "  ") +
									line,
							),
					invalidate: () => markdown.invalidate(),
					handleMouse: (event: TuiMouseEvent) => {
						if (
							event.x === this.outputPad &&
							event.y === 0 &&
							event.type === "click" &&
							event.button === "left" &&
							!this.isStreaming &&
							this.stats
						) {
							this.statsExpanded = !this.statsExpanded;
							return { handled: true };
						}
						return event.x < this.outputPad + 2
							? undefined
							: markdown.handleMouse({
									...event,
									x: event.x - this.outputPad - 2,
									width: Math.max(1, event.width - this.outputPad - 2),
								});
					},
				});
				hasPreviousBlock = true;
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				const active = this.isStreaming && i === message.content.length - 1 && !this.completedBlocks.has(i);
				const runIndex = thinkingRunIndex++;
				const thinkingText = thinkingBlocks.join("\n\n");
				const lineCount = thinkingText.split("\n").length;
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? (this.hideThinkingBlock && lineCount > 3);
				const excerpt = thinkingText.replace(/\s+/g, " ");
				const thinkingLabel = this.hiddenThinkingLabel === "Thinking..." ? "" : `${this.hiddenThinkingLabel} `;
				if (hasPreviousBlock)
					this.contentContainer.addChild({ render: () => [activityRail(this.outputPad)], invalidate: () => {} });
				const thinkingComponent = new Container();
				thinkingComponent.addChild({
					render: (width: number) => [
						" ".repeat(this.outputPad) +
							truncateToWidth(
								(active ? this.marker(true, "thinkingText") : theme.fg("thinkingText", hidden ? "▸" : "▾")) +
									theme.fg("thinkingText", ` ${thinkingLabel}${hidden ? excerpt : ""}`),
								Math.max(1, width - this.outputPad),
								"…",
							),
					],
					invalidate: () => {},
				});
				if (!hidden) {
					thinkingComponent.addChild(
						new ThinkingRail(
							new Markdown(
								thinkingText,
								0,
								0,
								this.markdownTheme,
								{
									color: (text: string) => theme.fg("thinkingText", text),
								},
								{
									transform: createMarkdownTransform(
										"assistant-thinking",
										this.isStreaming,
										this.markdownTransformers,
									),
									onCopyCode: (code) => {
										void copyToClipboard(code);
									},
								},
							),
							this.outputPad,
						),
					);
				}
				this.contentContainer.addChild(
					new MouseRegion(thinkingComponent, (event) => {
						if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
						this.thinkingVisibilityOverrides.set(runIndex, !hidden);
						if (this.lastMessage) this.updateContent(this.lastMessage);
						return { handled: true };
					}),
				);
				hasPreviousBlock = true;
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.addNotice("warning", "Response incomplete", "Response was truncated before completion.");
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted" ? message.errorMessage : "";
				this.addNotice("info", "Cancelled", abortMessage);
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.addNotice("error", "Response failed", errorMsg);
			}
		}
	}

	private addNotice(tone: "error" | "warning" | "info", title: string, body: string): void {
		if (this.contentContainer.children.length > 0) this.contentContainer.addChild(new Spacer(1));
		const notice = new TranscriptNotice({ tone, title, body });
		notice.setExpanded(this.expanded);
		this.notices.push(notice);
		this.contentContainer.addChild(notice);
	}
}
