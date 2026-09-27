import {
	type Component,
	type Focusable,
	isFocusable,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@candy/tui";
import type { AnimationIntensity } from "../../../core/settings-manager.ts";
import type { CustomEditor } from "./custom-editor.ts";
import { PanelTransition } from "./panel-transition.ts";

export type PanelContent = Component & { setAvailableHeight?(height: number): void };

export class ComposerPanel implements Component, Focusable {
	private readonly ui: TUI;
	private readonly editor: CustomEditor;
	private readonly transition: PanelTransition;
	private content: PanelContent | undefined;
	private compact = false;
	private heightRatio = 0.8;
	private focusedValue = false;
	private visibleRows = 0;

	constructor(ui: TUI, editor: CustomEditor) {
		this.ui = ui;
		this.editor = editor;
		this.transition = new PanelTransition(() => ui.requestRender());
	}

	get focused(): boolean {
		return this.focusedValue;
	}
	set focused(value: boolean) {
		this.focusedValue = value;
		if (this.content && isFocusable(this.content)) this.content.focused = value;
	}

	setOptions(enabled: boolean, intensity: AnimationIntensity): void {
		this.transition.setOptions(enabled, intensity);
	}

	show(content: PanelContent, compact = false, heightRatio = 0.8): void {
		if (this.content && isFocusable(this.content)) this.content.focused = false;
		this.content = content;
		this.compact = compact;
		this.heightRatio = heightRatio;
		if (isFocusable(content)) content.focused = this.focusedValue;
		this.transition.setOpen(true);
	}

	close(complete: () => void): void {
		this.transition.setOpen(false, complete);
	}

	dispose(): void {
		this.transition.dispose();
	}

	invalidate(): void {
		this.content?.invalidate();
	}
	isShowing(component: Component): boolean {
		return this.content === component;
	}
	handleInput(data: string): void {
		this.content?.handleInput?.(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.y < 1 || event.y > this.visibleRows) return;
		const result = this.content?.handleMouse?.({
			...event,
			x: event.x - 2,
			y: event.y - 1,
			width: Math.max(1, event.width - 4),
			height: this.visibleRows,
		});
		return result ? { ...result, focus: true } : undefined;
	}

	render(width: number): string[] {
		if (!this.content) return this.editor.render(width);
		const innerWidth = Math.max(1, width - 4);
		const available = Math.max(3, Math.floor(this.ui.terminal.rows * this.heightRatio) - 2);
		this.content.setAvailableHeight?.(available);
		const lines = this.content.render(innerWidth);
		const height = this.compact ? Math.min(available, lines.length) : available;
		const progress = this.transition.value();
		const growth = Math.max(0, Math.min(1, (progress - 0.12) / 0.55));
		this.visibleRows = Math.max(2, Math.round(2 + (height - 2) * growth));
		const motion = this.editor.getFrameMotion();
		motion.setGeometry(width, this.visibleRows + 2, 4, Math.min(width - 2, 30));
		const topProgress = progress < 0.12 ? 1 - progress / 0.12 : Math.min(1, Math.max(0, (progress - 0.65) / 0.08));
		const half = Math.ceil((Math.max(0, width - 2) / 2) * topProgress);
		const top = "─".repeat(half) + " ".repeat(Math.max(0, width - 2 - half * 2)) + "─".repeat(half);
		const result = [
			motion.paintBorder(
				`${progress > 0.12 ? "┌" : "╭"}${truncateToWidth(top, Math.max(0, width - 2), "")}${progress > 0.12 ? "┐" : "╮"}`,
				0,
				0,
			),
		];
		for (let row = 0; row < this.visibleRows; row++) {
			const shown = progress >= 0.73 + (row / Math.max(1, height)) * 0.25;
			const text = shown ? truncateToWidth(lines[row] ?? "", innerWidth, "") : "";
			result.push(
				motion.paintBorder("│ ", 0, row + 1) +
					text +
					" ".repeat(Math.max(0, innerWidth - visibleWidth(text))) +
					motion.paintBorder(" │", width - 2, row + 1),
			);
		}
		result.push(this.editor.renderPanelFooter(width));
		return result.map((line) => truncateToWidth(line, width, ""));
	}
}
