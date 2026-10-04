import type { AgentTool } from "@candy/agent-core";
import type { ExtensionRunner, ToolDefinition } from "./extensions/index.ts";
import { type ToolInfo, wrapRegisteredTools } from "./extensions/index.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

export interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export interface SessionToolRegistryOptions {
	activeToolNames?: string[];
	includeAllExtensionTools?: boolean;
}

export class SessionTools {
	private readonly allowedToolNames?: Set<string>;
	private readonly excludedToolNames?: Set<string>;
	private baseDefinitions = new Map<string, ToolDefinition>();
	private toolRegistry = new Map<string, AgentTool>();
	private definitions = new Map<string, ToolDefinitionEntry>();
	private promptSnippets = new Map<string, string>();
	private promptGuidelines = new Map<string, string[]>();
	private activeToolNames: string[] = [];
	private codemodeDisabled = false;
	private runtimeDefinitions: ToolDefinition[] = [];

	constructor(allowedToolNames?: string[], excludedToolNames?: string[]) {
		this.allowedToolNames = allowedToolNames ? new Set(allowedToolNames) : undefined;
		this.excludedToolNames = excludedToolNames ? new Set(excludedToolNames) : undefined;
	}

	setBaseDefinitions(definitions: Record<string, ToolDefinition>): void {
		this.baseDefinitions = new Map(Object.entries(definitions));
	}

	setRuntimeDefinitions(definitions: ToolDefinition[]): void {
		this.runtimeDefinitions = definitions;
	}

	setCodemodeDisabled(disabled: boolean): void {
		this.codemodeDisabled = disabled;
	}

	refresh(
		runner: ExtensionRunner,
		customTools: ToolDefinition[],
		previousActiveToolNames: string[],
		options?: SessionToolRegistryOptions,
	): string[] {
		const previousRegistryNames = new Set(this.toolRegistry.keys());
		const isAllowed = (name: string): boolean =>
			(!this.allowedToolNames ||
				this.allowedToolNames.has(name) ||
				((name === "codemode" || name === "search_mcp_tools") && this.allowedToolNames.size > 0)) &&
			!this.excludedToolNames?.has(name);
		const extensionTools = runner.getAllRegisteredTools();
		const allCustomTools = [
			...extensionTools,
			...this.runtimeDefinitions.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<mcp:${definition.name}>`, { source: "mcp" }),
			})),
			...customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowed(tool.definition.name));

		this.definitions = new Map(
			Array.from(this.baseDefinitions.entries())
				.filter(([name]) => isAllowed(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			this.definitions.set(tool.definition.name, { definition: tool.definition, sourceInfo: tool.sourceInfo });
		}

		this.promptSnippets = new Map(
			Array.from(this.definitions.values())
				.map(({ definition }) => {
					const snippet = this.normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this.promptGuidelines = new Map(
			Array.from(this.definitions.values())
				.map(({ definition }) => {
					const guidelines = this.normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);

		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner) as AgentTool[];
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this.baseDefinitions.values())
				.filter((definition) => isAllowed(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);
		this.toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools) this.toolRegistry.set(tool.name, tool);

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowed(name));
		if (this.allowedToolNames) {
			for (const toolName of this.toolRegistry.keys()) {
				if (this.allowedToolNames.has(toolName) && !previousRegistryNames.has(toolName))
					nextActiveToolNames.push(toolName);
			}
		} else if (options?.includeAllExtensionTools) {
			const runtimeNames = new Set(this.runtimeDefinitions.map((tool) => tool.name));
			for (const tool of wrappedExtensionTools) {
				if (!runtimeNames.has(tool.name) || !previousRegistryNames.has(tool.name))
					nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this.toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) nextActiveToolNames.push(toolName);
			}
		}
		if (!this.codemodeDisabled && isAllowed("codemode") && this.getCodemodeTools(nextActiveToolNames).length > 0) {
			nextActiveToolNames.push("codemode");
		}
		return this.withMcpDiscovery(nextActiveToolNames);
	}

	setActiveTools(names: string[], explicit = false): void {
		if (explicit) {
			if (names.includes("codemode")) this.codemodeDisabled = false;
			else if (this.activeToolNames.includes("codemode")) this.codemodeDisabled = true;
			if (!this.codemodeDisabled && this.toolRegistry.has("codemode") && this.getCodemodeTools(names).length > 0)
				names = [...names, "codemode"];
		}
		this.activeToolNames = this.withMcpDiscovery(names);
	}

	private withMcpDiscovery(names: string[]): string[] {
		const available =
			this.toolRegistry.has("codemode") && names.includes("codemode") && this.getCodemodeTools(names).length > 0;
		const active = names.filter(
			(name) => this.toolRegistry.has(name) && ((name !== "codemode" && name !== "search_mcp_tools") || available),
		);
		if (available && this.toolRegistry.has("search_mcp_tools")) active.push("search_mcp_tools");
		return [...new Set(active)];
	}

	getCodemodeTools(names: readonly string[] = this.activeToolNames): AgentTool[] {
		return names.flatMap((name) => {
			const tool = this.getTool(name);
			return tool?.exposure === "codemode" && this.definitions.get(name)?.sourceInfo.source === "mcp" ? [tool] : [];
		});
	}

	getActiveToolNames(): string[] {
		return [...this.activeToolNames];
	}

	getDirectTools(): AgentTool[] {
		return this.activeToolNames.flatMap((name) => {
			const tool = this.getTool(name);
			return tool && (!tool.exposure || tool.exposure === "direct") ? [tool] : [];
		});
	}

	getTool(name: string): AgentTool | undefined {
		return this.toolRegistry.get(name);
	}

	getDefinition(name: string): ToolDefinition | undefined {
		return this.definitions.get(name)?.definition;
	}

	getAllDefinitions(): ToolInfo[] {
		return Array.from(this.definitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			outputSchema: definition.outputSchema,
			exposure: definition.exposure,
			namespace: definition.namespace,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolNames(): string[] {
		return [...this.toolRegistry.keys()];
	}

	getPromptSnippets(): ReadonlyMap<string, string> {
		return this.promptSnippets;
	}

	getPromptGuidelines(): ReadonlyMap<string, string[]> {
		return this.promptGuidelines;
	}

	private normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) return [];
		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) unique.add(normalized);
		}
		return Array.from(unique);
	}
}
