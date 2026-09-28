import type { Component } from "@candy/tui";
import type { PanelContent } from "./components/composer-panel.ts";

export interface InteractivePageControllerHost {
	suspendPresentation(content: Component): void;
	closeTranscriptSearch(content: Component): void;
	mount(content: PanelContent, compact: boolean, heightRatio: number, inputTarget: Component): void;
	resumePresentation(): boolean;
	focusEditor(): void;
	closeAnimation(onComplete: () => void): void;
	restoreEditor(): void;
	requestRender(): void;
}

export class InteractivePageController {
	private generationValue = 0;
	private activeSelectorToken: object | undefined;
	private activeSelectorDispose: (() => void) | undefined;
	private readonly host: InteractivePageControllerHost;

	constructor(host: InteractivePageControllerHost) {
		this.host = host;
	}

	get generation(): number {
		return this.generationValue;
	}

	disposeActiveSelector(): void {
		const dispose = this.activeSelectorDispose;
		this.activeSelectorToken = undefined;
		this.activeSelectorDispose = undefined;
		dispose?.();
	}

	mountPanel(content: PanelContent, compact = false, heightRatio = 0.8, inputTarget: Component = content): void {
		this.host.suspendPresentation(content);
		this.host.closeTranscriptSearch(content);
		this.generationValue++;
		this.host.mount(content, compact, heightRatio, inputTarget);
		this.host.requestRender();
	}

	closePanel(): void {
		if (this.host.resumePresentation()) return;
		const generation = this.generationValue;
		this.host.focusEditor();
		this.host.closeAnimation(() => {
			if (this.generationValue !== generation) return;
			this.host.restoreEditor();
			this.host.requestRender();
		});
	}

	showSelector(
		create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
		compact = false,
		heightRatio = 0.8,
	): void {
		const token = {};
		let dispose: (() => void) | undefined;
		const done = () => {
			dispose?.();
			if (this.activeSelectorToken !== token) return;
			this.activeSelectorToken = undefined;
			this.activeSelectorDispose = undefined;
			this.closePanel();
		};
		const created = create(done);
		dispose = created.dispose;
		this.disposeActiveSelector();
		this.activeSelectorToken = token;
		this.activeSelectorDispose = dispose;
		this.mountPanel(created.component, compact, heightRatio, created.focus);
	}
}
