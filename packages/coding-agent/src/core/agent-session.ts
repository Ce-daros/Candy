import type { ModelSelection } from "./model-selection.ts";
import type { ResourceOperations } from "./resource-operations.ts";
import { SessionExecution, type SessionExecutionConfig } from "./session-execution.ts";
import type { SessionHistory } from "./session-history.ts";

export * from "./session-execution.ts";

export class AgentSession {
	readonly execution: SessionExecution;
	readonly history: SessionHistory;
	readonly selection: ModelSelection;
	readonly resources: ResourceOperations;

	constructor(config: SessionExecutionConfig) {
		this.history = config.sessionManager;
		this.execution = new SessionExecution(config);
		this.selection = this.execution.selection;
		this.resources = this.execution.resources;
	}
}
