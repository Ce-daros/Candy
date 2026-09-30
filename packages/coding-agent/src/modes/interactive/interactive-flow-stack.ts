import type { Component } from "@candy/tui";

export interface InteractiveFlowFrame {
	role: "presentation" | "panel";
	kind: string;
	content: Component;
	controller: AbortController;
	selector?: boolean;
	onSuspend?: () => void;
	onResume?: () => void;
	dispose?: () => void;
}

export class InteractiveFlowStack {
	private readonly frames: InteractiveFlowFrame[] = [];
	private generationValue = 0;
	private readonly listeners = new Set<(generation: number) => void>();

	get generation(): number {
		return this.generationValue;
	}

	get current(): InteractiveFlowFrame | undefined {
		return this.frames.at(-1);
	}

	get all(): readonly InteractiveFlowFrame[] {
		return this.frames;
	}

	subscribe(listener: (generation: number) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private advanceGeneration(): void {
		this.generationValue++;
		for (const listener of this.listeners) listener(this.generationValue);
	}

	push<T extends Omit<InteractiveFlowFrame, "controller">>(data: T): T & InteractiveFlowFrame {
		this.current?.onSuspend?.();
		const frame = { ...data, controller: new AbortController() };
		this.frames.push(frame);
		this.advanceGeneration();
		return frame;
	}

	replace<T extends Omit<InteractiveFlowFrame, "controller">>(data: T): T & InteractiveFlowFrame {
		const previous = this.current;
		if (!previous) return this.push(data);
		const frame = { ...data, controller: new AbortController() };
		this.frames[this.frames.length - 1] = frame;
		this.advanceGeneration();
		previous.controller.abort();
		previous.dispose?.();
		return frame;
	}

	pop(frame = this.current): boolean {
		if (!frame || this.current !== frame) return false;
		this.frames.pop();
		this.advanceGeneration();
		frame.controller.abort();
		frame.dispose?.();
		this.current?.onResume?.();
		return true;
	}

	clear(): void {
		for (let index = this.frames.length - 1; index >= 0; index--) {
			const frame = this.frames[index]!;
			frame.controller.abort();
			frame.dispose?.();
		}
		this.frames.length = 0;
		this.advanceGeneration();
	}

	has(frame: InteractiveFlowFrame): boolean {
		return this.frames.includes(frame);
	}

	last(role: InteractiveFlowFrame["role"]): InteractiveFlowFrame | undefined {
		for (let index = this.frames.length - 1; index >= 0; index--) {
			const frame = this.frames[index];
			if (frame?.role === role) return frame;
		}
		return undefined;
	}

	parentOf(frame: InteractiveFlowFrame): InteractiveFlowFrame | undefined {
		const index = this.frames.indexOf(frame);
		return index > 0 ? this.frames[index - 1] : undefined;
	}

	closeFrom(frame: InteractiveFlowFrame): boolean {
		const index = this.frames.indexOf(frame);
		if (index < 0) return false;
		const removed = this.frames.splice(index);
		for (let itemIndex = removed.length - 1; itemIndex >= 0; itemIndex--) {
			const removedFrame = removed[itemIndex]!;
			removedFrame.controller.abort();
			removedFrame.dispose?.();
		}
		this.advanceGeneration();
		this.current?.onResume?.();
		return true;
	}
}
