import { createInitialSystemMessage, getCurrentSystemMessage, toToolDeclaration } from "@candy/ai";
import {
	AgentInputs,
	type AgentLoopHost,
	type AgentMessage,
	type AgentOptions,
	Agent as CoreAgent,
	type QueueMode,
} from "../src/index.ts";

export interface TestAgentOptions extends Omit<AgentOptions, "host" | "inputs" | "initialState"> {
	host?: Partial<AgentLoopHost>;
	initialState?: AgentOptions["initialState"] & { messages?: AgentMessage[]; systemPrompt?: string };
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
}

class MemoryHistory {
	private entries: AgentMessage[];
	constructor(initial: TestAgentOptions["initialState"]) {
		this.entries = initial?.messages?.slice() ?? [];
		const system = createInitialSystemMessage(initial?.systemPrompt, initial?.tools?.map(toToolDeclaration));
		if (system && this.entries[0]?.role !== "system") this.entries.unshift(system);
	}
	get messages(): AgentMessage[] {
		return this.entries.slice();
	}
	set messages(messages: AgentMessage[]) {
		this.entries = messages.slice();
	}
	commit(message: AgentMessage) {
		this.entries.push(message);
		return { message, entryId: undefined };
	}
	reset() {
		const system = getCurrentSystemMessage(this.entries);
		this.entries = system ? [system] : [];
	}
}

export class Agent extends CoreAgent {
	readonly history: MemoryHistory;
	readonly loopHost: AgentLoopHost;
	constructor(options: TestAgentOptions) {
		const history = new MemoryHistory(options.initialState);
		const host: AgentLoopHost = {
			messages: () => history.messages,
			commit: (message) => history.commit(message),
			reset: () => history.reset(),
			...options.host,
		};
		super({ ...options, host, inputs: new AgentInputs(options.steeringMode, options.followUpMode) });
		this.history = history;
		this.loopHost = host;
	}
}
