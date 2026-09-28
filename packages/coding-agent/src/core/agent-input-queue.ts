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

export class AgentInputQueue {
	private readonly agent: Agent;
	private readonly onChange: () => void;
	private steering: Array<QueuedInput & { message: AgentMessage }> = [];
	private followUp: Array<QueuedInput & { message: AgentMessage }> = [];
	private deferred: DeferredInput[] = [];

	constructor(agent: Agent, onChange: () => void) {
		this.agent = agent;
		this.onChange = onChange;
	}

	queueForCompaction(text: string, mode: InputQueueMode, options?: PromptOptions): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.deferred.push({ text, mode, options, resolve, reject });
			this.onChange();
		});
	}

	get hasDeferred(): boolean {
		return this.deferred.length > 0;
	}

	takeDeferred(): DeferredInput | undefined {
		const input = this.deferred.shift();
		if (input) this.onChange();
		return input;
	}

	queue(mode: InputQueueMode, text: string, images?: ImageContent[]): void {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) content.push(...images);
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
		const queue = mode === "steer" ? this.steering : this.followUp;
		queue.push({ text, images, message });
		if (mode === "steer") this.agent.steer(message);
		else this.agent.followUp(message);
		this.onChange();
	}

	markStarted(message: AgentMessage): void {
		const steeringIndex = this.steering.findIndex((item) => item.message === message);
		if (steeringIndex !== -1) {
			this.steering.splice(steeringIndex, 1);
			this.onChange();
			return;
		}
		const followUpIndex = this.followUp.findIndex((item) => item.message === message);
		if (followUpIndex !== -1) {
			this.followUp.splice(followUpIndex, 1);
			this.onChange();
		}
	}

	get count(): number {
		return this.steering.length + this.followUp.length + this.deferred.length;
	}

	getTexts(mode: InputQueueMode): readonly string[] {
		const queued = mode === "steer" ? this.steering : this.followUp;
		return [
			...queued.map((item) => item.text),
			...this.deferred.filter((item) => item.mode === mode).map((item) => item.text),
		];
	}

	withdraw(): { steering: QueuedInput[]; followUp: QueuedInput[] } {
		const snapshot = {
			steering: this.steering.map(({ text, images }) => ({ text, ...(images && { images }) })),
			followUp: this.followUp.map(({ text, images }) => ({ text, ...(images && { images }) })),
		};
		for (const item of this.deferred) {
			const input = { text: item.text, ...(item.options?.images && { images: item.options.images }) };
			if (item.mode === "steer") snapshot.steering.push(input);
			else snapshot.followUp.push(input);
			item.resolve();
		}
		this.deferred = [];
		this.steering = [];
		this.followUp = [];
		this.agent.clearAllQueues();
		this.onChange();
		return snapshot;
	}

	rejectDeferred(error: Error): void {
		for (const item of this.deferred.splice(0)) item.reject(error);
	}
}
