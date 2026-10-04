import type { ElicitRequestParams, ElicitResult } from "@modelcontextprotocol/client";

export type McpExposure = "direct" | "codemode" | "hidden";
export type McpConfigScope = "global" | "project";

export interface McpOAuthConfig {
	clientId?: string;
	clientMetadataUrl?: string;
	scope?: string;
}

export interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	oauth?: McpOAuthConfig;
	enabled?: boolean;
	exposure?: McpExposure;
}

export interface McpConfigFile {
	mcpServers: Record<string, McpServerConfig>;
}

export interface McpServerState {
	name: string;
	transport: "stdio" | "http";
	enabled: boolean;
	exposure: McpExposure;
	status: "disabled" | "connecting" | "connected" | "needs-auth" | "error";
	protocolVersion?: string;
	serverName?: string;
	toolsCount: number;
	error?: string;
}

export type McpInteractionRequest =
	| { type: "elicitation"; server: string; request: ElicitRequestParams }
	| { type: "authorization"; server: string; url: string };

export type McpInteractionHandler = (request: McpInteractionRequest, signal?: AbortSignal) => Promise<ElicitResult>;
