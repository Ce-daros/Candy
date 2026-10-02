import {
	type Component,
	CURSOR_MARKER,
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
import { PanelTransition, panelPhase, panelRowVisible } from "./panel-transition.ts";

export type PanelContent = Component & {
	setAvailableHeight?(height: number): void;
};

export class ComposerPanel implements Component, Focusable {
	private readonly ui: TUI;
	private readonly editor: CustomEditor;
	private readonly transition: PanelTransition;
	private displayedLines: string[] = [];
	private closingLines: string[] | undefined;
	private shownRows = new Set<number>();
	private content: PanelContent | undefined;
	private inputTarget: Component | undefined;
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
		if (this.inputTarget && isFocusable(this.inputTarget)) this.inputTarget.focused = value;
	}

	setOptions(enabled: boolean, intensity: AnimationIntensity): void {
		this.transition.setOptions(enabled, intensity);
	}

	show(content: PanelContent, heightRatio = 0.8, inputTarget: Component = content): void {
		this.closingLines = undefined;
		if (this.content !== content) {
			this.transition.snap(0);
		}
		if (this.inputTarget && isFocusable(this.inputTarget)) this.inputTarget.focused = false;
		this.content = content;
		this.inputTarget = inputTarget;
		this.heightRatio = heightRatio;
		if (isFocusable(inputTarget)) inputTarget.focused = this.focusedValue;
		this.transition.setOpen(true);
	}

	close(complete: () => void): void {
		this.closingLines = this.displayedLines.map((line) => line.replaceAll(CURSOR_MARKER, ""));
		if (this.inputTarget && isFocusable(this.inputTarget)) this.inputTarget.focused = false;
		this.content = undefined;
		this.inputTarget = undefined;
		this.transition.setOpen(false, () => {
			this.content = undefined;
			this.inputTarget = undefined;
			this.displayedLines = [];
			this.closingLines = undefined;
			complete();
		});
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
		this.inputTarget?.handleInput?.(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.y < 1 || event.y > this.visibleRows) return;
		if (!this.shownRows.has(event.y - 1)) return;
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
		if (!this.content && !this.closingLines) return this.editor.render(width);
		const innerWidth = Math.max(1, width - 4);
		const available = Math.max(3, Math.floor(this.ui.terminal.rows * this.heightRatio) - 2);
		this.content?.setAvailableHeight?.(available);
		const targetLines = this.closingLines ?? this.content!.render(innerWidth);
		const lines = targetLines.slice(0, available);
		const height = Math.min(available, lines.length);
		const progress = this.transition.value();
		const { expanded, growth, topReveal } = panelPhase(progress);
		this.visibleRows = Math.max(2, Math.round(2 + (height - 2) * growth));
		const motion = this.editor.getFrameMotion();
		motion.setGeometry(width, this.visibleRows + 2, 4, Math.min(width - 2, 30));
		const half = Math.ceil((Math.max(0, width - 2) / 2) * topReveal);
		const top = "─".repeat(half) + " ".repeat(Math.max(0, width - 2 - half * 2)) + "─".repeat(half);
		const result = [
			motion.paintBorder(
				`${expanded ? "┌" : "╭"}${truncateToWidth(top, Math.max(0, width - 2), "")}${expanded ? "┐" : "╮"}`,
				0,
				0,
			),
		];
		this.shownRows.clear();
		this.displayedLines = [];
		for (let row = 0; row < this.visibleRows; row++) {
			const shown = panelRowVisible(progress, row, height, 0.73);
			const text = shown ? truncateToWidth(lines[row] ?? "", innerWidth, "") : "";
			if (shown) this.shownRows.add(row);
			this.displayedLines.push(text);
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
