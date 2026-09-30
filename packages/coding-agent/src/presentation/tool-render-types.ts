import type { AgentToolResult } from "@candy/agent-core";
import type { Component } from "@candy/tui";
import type { Theme } from "../contracts/theme.ts";

export type ToolPreviewLines = 5 | 10 | 20;

export interface ToolRenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

export interface ToolRenderContext<TState = any, TArgs = any> {
	previewLines: ToolPreviewLines;
	args: TArgs;
	toolCallId: string;
	invalidate: () => void;
	lastComponent: Component | undefined;
	state: TState;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
}

export interface ToolRenderers<TArgs = any, TDetails = any, TState = any> {
	renderShell?: "default" | "self";
	renderCall?: (args: TArgs, theme: Theme, context: ToolRenderContext<TState, TArgs>) => Component;
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<TState, TArgs>,
	) => Component;
}
