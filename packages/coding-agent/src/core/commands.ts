import type { SourceInfo } from "./source-info.ts";

export type CommandSource = "extension" | "prompt" | "skill";

export interface CommandInvocation {
	source: CommandSource;
	name: string;
	args: string;
}

export interface CommandInfo {
	source: CommandSource;
	name: string;
	description?: string;
	argumentHint?: string;
	sourceInfo: SourceInfo;
}
