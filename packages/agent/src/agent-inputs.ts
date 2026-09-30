import type { ImageContent } from "@candy/ai";
import type { AgentMessage, QueueMode } from "./types.ts";
export interface QueuedAgentInput {
	readonly text: string;
	readonly images?: readonly ImageContent[];
}

function queuedInputFromMessage(message: AgentMessage): QueuedAgentInput {
	if (message.role !== "user") return { text: "" };
	if (typeof message.content === "string") return { text: message.content };
	const text = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const images = message.content.filter((part): part is ImageContent => part.type === "image");
	return { text, ...(images.length > 0 && { images }) };
}

function cloneQueuedInput(input: QueuedAgentInput): QueuedAgentInput {
	return {
		text: input.text,
		...(input.images !== undefined && { images: input.images.map((image) => ({ ...image })) }),
	};
}

class PendingMessageQueue {
	private messages: Array<QueuedAgentInput & { message: AgentMessage }> = [];
	public mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(message: AgentMessage, input: QueuedAgentInput): void {
		this.messages.push({ ...cloneQueuedInput(input), message });
	}

	hasItems(): boolean {
		return this.messages.length > 0;
	}

	peek(): AgentMessage[] {
		if (this.mode === "all") return this.messages.map((item) => item.message);
		const first = this.messages[0];
		return first ? [first.message] : [];
	}

	drain(): AgentMessage[] {
		const drained = this.peek();
		this.messages = this.messages.slice(drained.length);
		return drained;
	}

	clear(): void {
		this.messages = [];
	}

	snapshot(): readonly QueuedAgentInput[] {
		return this.messages.map(({ text, images }) => cloneQueuedInput({ text, images }));
	}

	withdraw(): QueuedAgentInput[] {
		const items = this.messages;
		this.messages = [];
		return items.map(({ message: _message, ...item }) => cloneQueuedInput(item));
	}
}

export class AgentInputs {
	private readonly queueListeners = new Set<() => void>();
	readonly steeringQueue: PendingMessageQueue;
	readonly followUpQueue: PendingMessageQueue;
	constructor(steeringMode: QueueMode = "one-at-a-time", followUpMode: QueueMode = "one-at-a-time") {
		this.steeringQueue = new PendingMessageQueue(steeringMode);
		this.followUpQueue = new PendingMessageQueue(followUpMode);
	}
	subscribeQueue(listener: () => void): () => void {
		this.queueListeners.add(listener);
		return () => this.queueListeners.delete(listener);
	}

	notifyQueueChanged(): void {
		for (const listener of this.queueListeners) listener();
	}
	/** Controls how queued steering messages are drained. */
	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	/** Controls how queued follow-up messages are drained. */
	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	/** Queue a message to be injected after the current assistant turn finishes. */
	steer(message: AgentMessage, input: QueuedAgentInput = queuedInputFromMessage(message)): void {
		this.steeringQueue.enqueue(message, input);
		this.notifyQueueChanged();
	}

	/** Queue a message to run only after the agent would otherwise stop. */
	followUp(message: AgentMessage, input: QueuedAgentInput = queuedInputFromMessage(message)): void {
		this.followUpQueue.enqueue(message, input);
		this.notifyQueueChanged();
	}

	getQueuedInputs(): { steering: readonly QueuedAgentInput[]; followUp: readonly QueuedAgentInput[] } {
		return { steering: this.steeringQueue.snapshot(), followUp: this.followUpQueue.snapshot() };
	}

	withdrawQueuedInputs(): { steering: QueuedAgentInput[]; followUp: QueuedAgentInput[] } {
		const inputs = { steering: this.steeringQueue.withdraw(), followUp: this.followUpQueue.withdraw() };
		this.notifyQueueChanged();
		return inputs;
	}

	/** Remove all queued steering messages. */
	clearSteeringQueue(): void {
		this.steeringQueue.clear();
		this.notifyQueueChanged();
	}

	/** Remove all queued follow-up messages. */
	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
		this.notifyQueueChanged();
	}

	/** Remove all queued steering and follow-up messages. */
	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	/** Returns true when either queue still contains pending messages. */
	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/** Preview the messages selected for the next turn without consuming them. */
	peekQueuedMessages(): AgentMessage[] {
		const steering = this.steeringQueue.peek();
		return steering.length > 0 ? steering : this.followUpQueue.peek();
	}
}
