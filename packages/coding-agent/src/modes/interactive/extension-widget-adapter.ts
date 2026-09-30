import { type Component, Container, Spacer, Text, type TUI } from "@candy/tui";
import type { Theme } from "../../contracts/theme.ts";
import type { ExtensionWidgetOptions } from "../../core/extensions/index.ts";
import { theme } from "./theme/theme.ts";

type ExtensionWidget = Component & { dispose?(): void };

export class ExtensionWidgetAdapter {
	readonly above = new Container();
	readonly below = new Container();
	private readonly widgetsAbove = new Map<string, ExtensionWidget>();
	private readonly widgetsBelow = new Map<string, ExtensionWidget>();
	private readonly tui: TUI;

	constructor(tui: TUI) {
		this.tui = tui;
	}

	set(
		key: string,
		content: string[] | ((tui: TUI, theme: Theme) => ExtensionWidget) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		this.remove(this.widgetsAbove, key);
		this.remove(this.widgetsBelow, key);

		if (content !== undefined) {
			const component = Array.isArray(content) ? this.createTextWidget(content) : content(this.tui, theme);
			(options?.placement === "belowEditor" ? this.widgetsBelow : this.widgetsAbove).set(key, component);
		}

		this.render();
	}

	clear(): void {
		for (const widgets of [this.widgetsAbove, this.widgetsBelow]) {
			for (const widget of widgets.values()) widget.dispose?.();
			widgets.clear();
		}
		this.render();
	}

	private createTextWidget(lines: string[]): Container {
		const container = new Container();
		for (const line of lines.slice(0, 10)) container.addChild(new Text(line, 1, 0));
		if (lines.length > 10) container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
		return container;
	}

	private remove(widgets: Map<string, ExtensionWidget>, key: string): void {
		const component = widgets.get(key);
		component?.dispose?.();
		widgets.delete(key);
	}

	private render(): void {
		this.renderContainer(this.above, this.widgetsAbove, true, true);
		this.renderContainer(this.below, this.widgetsBelow, false, false);
		this.tui.requestRender();
	}

	private renderContainer(
		container: Container,
		widgets: Map<string, ExtensionWidget>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();
		if (widgets.size === 0) {
			if (spacerWhenEmpty) container.addChild(new Spacer(1));
			return;
		}
		if (leadingSpacer) container.addChild(new Spacer(1));
		for (const component of widgets.values()) container.addChild(component);
	}
}
