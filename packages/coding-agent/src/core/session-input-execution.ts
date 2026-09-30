import type { Agent, AgentMessage } from "@candy/agent-core";
import type { ImageContent, TextContent } from "@candy/ai";
import type { PromptOptions, QueuedInput } from "./agent-session.ts";

export type InputQueueMode = "steer" | "followUp";

export interface DeferredInput extends QueuedInput {
	mode: InputQueueMode;
	options?: PromptOptions;
	resolve: () => void;
	reject: (error: unknown) => void;
}

export class SessionInputExecution {
	private readonly agent: Agent;
	private readonly onQueueChanged: () => void;
	private deferredInputs: DeferredInput[] = [];

	constructor(agent: Agent, onQueueChanged: () => void) {
		this.agent = agent;
		this.onQueueChanged = onQueueChanged;
	}

	deferDuringCompaction(text: string, mode: InputQueueMode, options?: PromptOptions): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.deferredInputs.push({ text, mode, options, resolve, reject });
			this.onQueueChanged();
		});
	}

	get hasDeferred(): boolean {
		return this.deferredInputs.length > 0;
	}

	takeDeferred(): DeferredInput | undefined {
		const input = this.deferredInputs.shift();
		if (input) this.onQueueChanged();
		return input;
	}

	queue(mode: InputQueueMode, text: string, images?: ImageContent[]): void {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) content.push(...images);
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
		const input = { text, ...(images && { images }) };
		if (mode === "steer") this.agent.steer(message, input);
		else this.agent.followUp(message, input);
	}

	get count(): number {
		const queued = this.agent.getQueuedInputs();
		return queued.steering.length + queued.followUp.length + this.deferredInputs.length;
	}

	getTexts(mode: InputQueueMode): readonly string[] {
		const queuedInputs = this.agent.getQueuedInputs();
		const queued = mode === "steer" ? queuedInputs.steering : queuedInputs.followUp;
		return [
			...queued.map((item) => item.text),
			...this.deferredInputs.filter((item) => item.mode === mode).map((item) => item.text),
		];
	}

	withdraw(): { steering: QueuedInput[]; followUp: QueuedInput[] } {
		const queued = this.agent.withdrawQueuedInputs();
		const snapshot = {
			steering: queued.steering.map(({ text, images }) => ({ text, ...(images && { images: [...images] }) })),
			followUp: queued.followUp.map(({ text, images }) => ({ text, ...(images && { images: [...images] }) })),
		};
		for (const item of this.deferredInputs) {
			const input = { text: item.text, ...(item.options?.images && { images: item.options.images }) };
			if (item.mode === "steer") snapshot.steering.push(input);
			else snapshot.followUp.push(input);
			item.resolve();
		}
		this.deferredInputs = [];
		return snapshot;
	}

	rejectDeferred(error: Error): void {
		const deferred = this.deferredInputs.splice(0);
		for (const item of deferred) item.reject(error);
		if (deferred.length > 0) this.onQueueChanged();
	}
}
