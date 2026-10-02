import type { Component } from "@candy/tui";
import type { PanelContent } from "./components/composer-panel.ts";
import type { PanelNavigation } from "./components/panel-transition.ts";
import { type InteractiveFlowFrame, InteractiveFlowStack } from "./interactive-flow-stack.ts";

export interface InteractivePageControllerHost {
	closeTranscriptSearch(content: Component): void;
	mount(content: PanelContent, heightRatio: number, inputTarget: Component, navigation: PanelNavigation): void;
	focusEditor(): void;
	closeAnimation(onComplete: () => void): void;
	restoreEditor(): void;
	requestRender(): void;
}

export class InteractivePageController {
	private readonly host: InteractivePageControllerHost;
	private readonly flows: InteractiveFlowStack;

	constructor(host: InteractivePageControllerHost, flows: InteractiveFlowStack = new InteractiveFlowStack()) {
		this.host = host;
		this.flows = flows;
	}

	get generation(): number {
		return this.flows.generation;
	}

	invalidateFlows(): void {
		this.flows.clear();
	}

	disposeActiveSelector(): void {
		const current = this.flows.current;
		if (current?.role === "panel" && current.selector) this.flows.pop(current);
	}

	mountPresentationPanel(content: PanelContent, heightRatio = 0.8, navigation: PanelNavigation = "enter"): void {
		this.host.closeTranscriptSearch(content);
		this.mount(content, heightRatio, content, navigation);
	}

	mountPanel(
		content: PanelContent,
		heightRatio = 0.8,
		inputTarget: Component = content,
		kind = "panel",
	): InteractiveFlowFrame {
		const frame = this.flows.push({
			role: "panel",
			kind,
			content,
			onResume: () => this.mount(content, heightRatio, inputTarget, "back"),
		});
		this.host.closeTranscriptSearch(content);
		this.mount(content, heightRatio, inputTarget, "enter");
		return frame;
	}

	get currentFrame(): InteractiveFlowFrame | undefined {
		return this.flows.current;
	}

	subscribeFlows(listener: (generation: number) => void): () => void {
		return this.flows.subscribe(listener);
	}

	contains(frame: InteractiveFlowFrame): boolean {
		return this.flows.has(frame);
	}

	isWithin(frame: InteractiveFlowFrame): boolean {
		let current = this.flows.current;
		while (current) {
			if (current === frame) return true;
			current = this.flows.parentOf(current);
		}
		return false;
	}

	dismissFrom(frame: InteractiveFlowFrame): boolean {
		const hadParent = this.flows.parentOf(frame) !== undefined;
		const dismissed = this.flows.closeFrom(frame);
		if (dismissed && !hadParent) this.closeToEditor();
		return dismissed;
	}

	closePanel(expectedFrame?: InteractiveFlowFrame): void {
		const current = this.flows.current;
		if (expectedFrame && current !== expectedFrame) return;
		if (current?.role === "presentation") return;
		if (current?.role === "panel") {
			const hasParent = this.flows.parentOf(current) !== undefined;
			this.flows.pop(current);
			if (hasParent) return;
		}
		this.closeToEditor();
	}

	showSelector(
		create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
		heightRatio = 0.8,
	): InteractiveFlowFrame {
		const previous = this.flows.current;
		let frame: InteractiveFlowFrame | undefined;
		const created = create(() => {
			if (!frame || this.flows.current !== frame) return;
			this.closePanel(frame);
		});
		const selector = {
			role: "panel",
			kind: "selector",
			selector: true,
			content: created.component,
			dispose: created.dispose,
			onResume: () => this.mount(created.component, heightRatio, created.focus, "back"),
		} as const;
		frame =
			previous?.role === "panel" && previous.selector ? this.flows.replace(selector) : this.flows.push(selector);
		this.host.closeTranscriptSearch(created.component);
		this.mount(created.component, heightRatio, created.focus, previous?.selector ? "replace" : "enter");
		return frame;
	}

	private mount(
		content: PanelContent,
		heightRatio: number,
		inputTarget: Component,
		navigation: PanelNavigation,
	): void {
		this.host.mount(content, heightRatio, inputTarget, navigation);
		this.host.requestRender();
	}

	private closeToEditor(): void {
		const generation = this.generation;
		this.host.focusEditor();
		this.host.closeAnimation(() => {
			if (this.generation !== generation || this.flows.current) return;
			this.host.restoreEditor();
			this.host.requestRender();
		});
	}
}
