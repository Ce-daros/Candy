import { Container, Spacer, Text, type TUI } from "@candy/tui";

export class ExtensionWidgetAdapter {
	readonly above = new Container();
	private readonly widgets = new Map<string, string[]>();
	private readonly tui: TUI;
	constructor(tui: TUI) {
		this.tui = tui;
	}
	set(key: string, lines: string[] | undefined): void {
		if (lines === undefined) this.widgets.delete(key);
		else this.widgets.set(key, lines);
		this.render();
	}
	clear(): void {
		this.widgets.clear();
		this.render();
	}
	private render(): void {
		this.above.clear();
		this.above.addChild(new Spacer(1));
		for (const lines of this.widgets.values()) {
			for (const line of lines) this.above.addChild(new Text(line, 1, 0));
		}
		this.tui.requestRender();
	}
}
