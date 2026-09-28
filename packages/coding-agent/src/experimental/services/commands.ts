import { type Context, defineService } from "@candy/chord";
import type { AgentOperationResponse, AgentQueueResponse } from "./agent-controller.ts";

export interface CommandCompletion {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

export type CommandRunResult = AgentOperationResponse | AgentQueueResponse | undefined;

export interface CommandContribution {
	readonly name: string;
	readonly source?: string;
	readonly description?: string;
	readonly argumentHint?: string;
	getArgumentCompletions?(
		argumentPrefix: string,
	): readonly CommandCompletion[] | null | Promise<readonly CommandCompletion[] | null>;
	run(args: string, context: Context): CommandRunResult | Promise<CommandRunResult>;
}

export interface Commands {
	register(command: CommandContribution): () => void;
	/** Stage a same-name replacement while the previous facet generation retires. */
	replace(command: CommandContribution): () => void;
	list(): readonly CommandContribution[];
	subscribe(listener: (commands: readonly CommandContribution[]) => void): () => void;
}

export const Commands = defineService<Commands>("pi.local.commands", { local: true });
