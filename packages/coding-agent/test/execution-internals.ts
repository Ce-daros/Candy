import type { Agent, AgentInputs } from "@candy/agent-core";
import type { SessionExecution } from "../src/core/session-execution.ts";

export function getTestAgent(execution: SessionExecution): Agent {
	return Reflect.get(execution, "agent") as Agent;
}

export function getTestInputs(execution: SessionExecution): AgentInputs {
	return Reflect.get(execution, "_inputs") as AgentInputs;
}
