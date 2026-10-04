import type { JsonValue } from "@candy/ai";
import { Client, StreamableHTTPClientTransport, type Tool, UnauthorizedError } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { type TSchema, Type } from "typebox";
import { VERSION } from "../../config.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SettingsManager } from "../settings-manager.ts";
import {
	getMcpConfigPaths,
	loadMcpConfig,
	type McpConfigPaths,
	readMcpConfig,
	resolveMcpServerConfig,
	writeMcpServerSetting,
} from "./config.ts";
import { createMcpTransportAuthProvider, loginToMcpServer, McpOAuthStore } from "./oauth.ts";
import { mcpResourceResult, mcpToolResult } from "./result.ts";
import type { McpConfigScope, McpExposure, McpInteractionHandler, McpServerConfig, McpServerState } from "./types.ts";

interface McpConnection {
	client: Client;
	config: McpServerConfig;
	state: McpServerState;
	tools: Tool[];
}

export interface McpRuntimeOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	signal?: AbortSignal;
	enabled?: boolean;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function slug(value: string): string {
	return (
		value
			.replace(/[^A-Za-z0-9_-]/g, "_")
			.replace(/_+/g, "_")
			.replace(/^_+|_+$/g, "") || "tool"
	);
}

function toolName(server: string, tool: string, occupied: Set<string>): string {
	const stem = `mcp_${slug(server)}_${slug(tool)}`;
	let candidate = stem.slice(0, 64);
	let suffix = 2;
	while (occupied.has(candidate)) {
		const ending = `_${suffix++}`;
		candidate = `${stem.slice(0, 64 - ending.length)}${ending}`;
	}
	occupied.add(candidate);
	return candidate;
}

export class McpRuntime {
	private readonly options: McpRuntimeOptions;
	private readonly paths: McpConfigPaths;
	private readonly authStore: McpOAuthStore;
	private readonly connections = new Map<string, McpConnection>();
	private readonly listeners = new Set<() => void>();
	private interaction?: McpInteractionHandler;
	private disposed = false;
	private reloadGeneration = 0;

	private constructor(options: McpRuntimeOptions) {
		this.options = options;
		this.paths = getMcpConfigPaths(options.cwd, options.agentDir);
		this.authStore = new McpOAuthStore(options.agentDir);
	}

	static async create(options: McpRuntimeOptions): Promise<McpRuntime> {
		const runtime = new McpRuntime(options);
		await runtime.reload();
		return runtime;
	}

	list(): McpServerState[] {
		return [...this.connections.values()].map(({ state }) => ({ ...state }));
	}

	getTools(): ToolDefinition[] {
		const definitions: ToolDefinition[] = [];
		const occupied = new Set<string>([
			"codemode",
			"search_mcp_tools",
			"list_mcp_resources",
			"list_mcp_resource_templates",
			"read_mcp_resource",
		]);
		for (const [server, connection] of this.connections) {
			if (connection.state.status !== "connected") continue;
			for (const tool of connection.tools) {
				const name = toolName(server, tool.name, occupied);
				definitions.push({
					name,
					label: tool.title ?? tool.name,
					description: tool.description ?? tool.title ?? tool.name,
					parameters: tool.inputSchema as TSchema,
					outputSchema: Type.Object({
						content: Type.Array(Type.Unknown()),
						structuredContent: Type.Optional((tool.outputSchema ?? Type.Unknown()) as TSchema),
						isError: Type.Optional(Type.Boolean()),
						files: Type.Optional(
							Type.Array(
								Type.Object({
									path: Type.String(),
									mimeType: Type.String(),
									description: Type.Optional(Type.String()),
								}),
							),
						),
					}),
					exposure: connection.state.exposure,
					namespace: { name: server, description: connection.state.serverName },
					execute: async (_id, params, signal) => {
						const result = await connection.client.callTool(
							{ name: tool.name, arguments: params as Record<string, unknown> },
							{ signal, toolDefinition: tool },
						);
						return mcpToolResult(result);
					},
				});
			}
		}
		if (
			[...this.connections.values()].some(
				({ state, client }) =>
					state.status === "connected" && state.exposure !== "hidden" && client.getServerCapabilities()?.resources,
			)
		)
			definitions.push(...this.resourceTools());
		return definitions;
	}

	private resourceTools(): ToolDefinition[] {
		const available = () =>
			[...this.connections.values()].filter(
				({ state, client }) =>
					state.status === "connected" && state.exposure !== "hidden" && client.getServerCapabilities()?.resources,
			);
		const serverSchema = Type.Union(available().map(({ state }) => Type.Literal(state.name)));
		return [
			{
				name: "list_mcp_resources",
				label: "List MCP resources",
				description: "List resources from a connected MCP server",
				parameters: Type.Object({ server: serverSchema }),
				exposure: "codemode",
				namespace: { name: "mcp", description: "MCP resources" },
				outputSchema: Type.Object({ resources: Type.Array(Type.Unknown()) }),
				execute: async (_id, { server }, signal) => {
					const connection = this.requireConnection(server);
					if (!available().includes(connection)) throw new Error(`MCP server ${server} is not available`);
					const result = await connection.client.listResources(undefined, { signal });
					const resources = result.resources.map(({ _meta: _private, ...resource }) => resource);
					return {
						content: [{ type: "text", text: JSON.stringify(resources) }],
						details: undefined,
						structuredContent: JSON.parse(JSON.stringify({ resources })) as JsonValue,
					};
				},
			},
			{
				name: "list_mcp_resource_templates",
				label: "List MCP resource templates",
				description: "List resource URI templates from a connected MCP server",
				parameters: Type.Object({ server: serverSchema }),
				exposure: "codemode",
				namespace: { name: "mcp", description: "MCP resources" },
				outputSchema: Type.Object({ resourceTemplates: Type.Array(Type.Unknown()) }),
				execute: async (_id, { server }, signal) => {
					const connection = this.requireConnection(server);
					if (!available().includes(connection)) throw new Error(`MCP server ${server} is not available`);
					const result = await connection.client.listResourceTemplates(undefined, { signal });
					const resourceTemplates = result.resourceTemplates.map(({ _meta: _private, ...resource }) => resource);
					return {
						content: [{ type: "text", text: JSON.stringify(resourceTemplates) }],
						details: undefined,
						structuredContent: JSON.parse(JSON.stringify({ resourceTemplates })) as JsonValue,
					};
				},
			},
			{
				name: "read_mcp_resource",
				label: "Read MCP resource",
				description: "Read an MCP resource by URI",
				parameters: Type.Object({ server: serverSchema, uri: Type.String() }),
				exposure: "codemode",
				namespace: { name: "mcp", description: "MCP resources" },
				outputSchema: Type.Object({
					contents: Type.Array(Type.Unknown()),
					files: Type.Optional(
						Type.Array(
							Type.Object({
								path: Type.String(),
								mimeType: Type.String(),
								description: Type.Optional(Type.String()),
							}),
						),
					),
				}),
				execute: async (_id, { server, uri }, signal) => {
					const connection = this.requireConnection(server);
					if (!available().includes(connection)) throw new Error(`MCP server ${server} is not available`);
					return mcpResourceResult(await connection.client.readResource({ uri }, { signal }));
				},
			},
		];
	}

	private requireConnection(name: string): McpConnection {
		const connection = this.connections.get(name);
		if (!connection || connection.state.status !== "connected")
			throw new Error(`MCP server ${name} is not connected`);
		return connection;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setInteraction(handler?: McpInteractionHandler): void {
		const capabilityChanged = Boolean(this.interaction) !== Boolean(handler);
		this.interaction = handler;
		if (capabilityChanged && this.connections.size > 0)
			void this.reload().catch((error) => this.reportReloadError(error));
	}

	private reportReloadError(error: unknown): void {
		for (const connection of this.connections.values()) {
			connection.state.status = "error";
			connection.state.error = message(error);
		}
		this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	async reload(): Promise<void> {
		if (this.disposed) throw new Error("MCP runtime is disposed");
		const generation = ++this.reloadGeneration;
		const config = loadMcpConfig(this.paths, this.options.settingsManager);
		await this.closeConnections();
		for (const [name, server] of Object.entries(config.mcpServers)) {
			const state: McpServerState = {
				name,
				transport: server.url ? "http" : "stdio",
				enabled: server.enabled !== false,
				exposure: server.exposure ?? "codemode",
				status: server.enabled === false || this.options.enabled === false ? "disabled" : "connecting",
				toolsCount: 0,
			};
			const client = new Client(
				{ name: "candy", version: VERSION },
				{
					versionNegotiation: { mode: "auto" },
					listChanged: {
						tools: {
							onChanged: (error, tools) => {
								const connection = this.connections.get(name);
								if (!connection || connection.client !== client) return;
								if (error) connection.state.error = `Tool list refresh failed: ${message(error)}`;
								else if (tools) {
									connection.tools = tools;
									connection.state.toolsCount = tools.length;
									connection.state.error = undefined;
								}
								this.emit();
							},
						},
					},
				},
			);
			client.onclose = () => {
				if (this.connections.get(name)?.client !== client || state.status !== "connected") return;
				state.status = "error";
				state.error = "MCP connection closed";
				state.toolsCount = 0;
				this.connections.get(name)!.tools = [];
				this.emit();
			};
			this.connections.set(name, { client, config: server, state, tools: [] });
		}
		this.emit();
		await Promise.all(
			[...this.connections.entries()]
				.filter(([, entry]) => entry.state.enabled && this.options.enabled !== false)
				.map(async ([name]) => this.connect(name, generation)),
		);
	}

	private async connect(name: string, generation: number): Promise<void> {
		const connection = this.connections.get(name);
		if (!connection) return;
		const { client, state } = connection;
		try {
			const config = await resolveMcpServerConfig(connection.config, this.options.cwd);
			const capabilities = this.interaction ? { elicitation: { form: {}, url: {} } } : {};
			client.registerCapabilities(capabilities);
			if (this.interaction)
				client.setRequestHandler("elicitation/create", async (request, ctx) => {
					const handler = this.interaction;
					if (!handler) throw new Error(`MCP server ${name} needs interactive input`);
					return handler({ type: "elicitation", server: name, request: request.params }, ctx.mcpReq.signal);
				});
			const transport = config.url
				? new StreamableHTTPClientTransport(new URL(config.url), {
						requestInit: { headers: config.headers },
						authProvider: createMcpTransportAuthProvider(name, config, this.authStore),
					})
				: new StdioClientTransport({
						command: config.command!,
						args: config.args,
						cwd: config.cwd ?? this.options.cwd,
						env: { ...getDefaultEnvironment(), ...config.env },
						stderr: "pipe",
					});
			await client.connect(transport, { signal: this.options.signal });
			const tools = client.getServerCapabilities()?.tools
				? (await client.listTools(undefined, { signal: this.options.signal })).tools
				: [];
			if (this.disposed || generation !== this.reloadGeneration) {
				await client.close();
				return;
			}
			connection.tools = tools;
			state.status = "connected";
			state.protocolVersion = client.getNegotiatedProtocolVersion();
			state.serverName = client.getServerVersion()?.name;
			state.toolsCount = tools.length;
			this.emit();
		} catch (error) {
			if (generation !== this.reloadGeneration) return;
			state.status = error instanceof UnauthorizedError ? "needs-auth" : "error";
			state.error = message(error);
			await client.close();
			this.emit();
		}
	}

	private async closeConnections(): Promise<void> {
		const clients = [...this.connections.values()].map(({ client }) => client);
		this.connections.clear();
		await Promise.all(clients.map((client) => client.close()));
	}

	async reconnect(name: string): Promise<void> {
		if (!this.connections.has(name)) throw new Error(`Unknown MCP server ${name}`);
		await this.reload();
	}

	private settingScope(name: string, scope?: McpConfigScope): McpConfigScope {
		const projectHasServer =
			this.options.settingsManager.isProjectTrusted() && Boolean(readMcpConfig(this.paths.project).mcpServers[name]);
		const globalHasServer = Boolean(readMcpConfig(this.paths.global).mcpServers[name]);
		if (scope === "global" && !globalHasServer) throw new Error(`MCP server ${name} is not in global configuration`);
		if (scope === "project" && !projectHasServer)
			throw new Error(`MCP server ${name} is not in project configuration`);
		return scope ?? (projectHasServer ? "project" : "global");
	}

	async setEnabled(name: string, enabled: boolean, scope?: McpConfigScope): Promise<void> {
		if (!this.connections.has(name)) throw new Error(`Unknown MCP server ${name}`);
		writeMcpServerSetting(
			this.paths,
			this.options.settingsManager,
			name,
			"enabled",
			enabled,
			this.settingScope(name, scope),
		);
		await this.reload();
	}

	async setExposure(name: string, exposure: McpExposure, scope?: McpConfigScope): Promise<void> {
		if (!this.connections.has(name)) throw new Error(`Unknown MCP server ${name}`);
		writeMcpServerSetting(
			this.paths,
			this.options.settingsManager,
			name,
			"exposure",
			exposure,
			this.settingScope(name, scope),
		);
		await this.reload();
	}

	async login(name: string, options?: { signal?: AbortSignal }): Promise<void> {
		const connection = this.connections.get(name);
		if (!connection?.config.url) throw new Error(`MCP server ${name} is not a configured HTTP server`);
		if (!this.interaction) throw new Error("MCP authorization requires interactive input");
		const config = await resolveMcpServerConfig(connection.config, this.options.cwd);
		await loginToMcpServer(name, config, this.authStore, this.interaction, options?.signal);
		await this.reconnect(name);
	}

	async logout(name: string): Promise<void> {
		const connection = this.connections.get(name);
		if (!connection?.config.url) throw new Error(`MCP server ${name} is not a configured HTTP server`);
		const config = await resolveMcpServerConfig(connection.config, this.options.cwd);
		this.authStore.remove(name, config.url!);
		await this.reconnect(name);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.reloadGeneration++;
		await this.closeConnections();
		this.listeners.clear();
	}
}
