import type { AgentTool } from "@candy/agent-core";
import { type CodemodeJsonSchema, renderToolSample, toCodemodeIdentifier } from "@candy/codemode";
import { Type } from "typebox";
import type { ToolDefinition } from "./extensions/types.ts";

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"with",
]);

/** Upstream pi's tokenization and BM25 ranking, scoped to the current callable tools. */
function tokens(value: string): string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 0 && !STOP_WORDS.has(term))
		.map((term) => {
			if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
			if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
			if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
			return term;
		});
}

function rankTools(query: string, tools: readonly AgentTool[]): AgentTool[] {
	const queryTerms = [...new Set(tokens(query))];
	if (queryTerms.length === 0 || tools.length === 0) return [];
	const counts = tools.map((tool) => {
		const terms = new Map<string, number>();
		const source = `${tool.name} ${tool.name.replaceAll("_", " ")} ${tool.description} ${tool.namespace?.name ?? ""} ${tool.namespace?.description ?? ""}`;
		for (const term of tokens(source)) terms.set(term, (terms.get(term) ?? 0) + 1);
		return terms;
	});
	const documentFrequencies = new Map<string, number>();
	for (const terms of counts) {
		for (const term of terms.keys()) documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
	}
	const lengths = counts.map((terms) => [...terms.values()].reduce((sum, count) => sum + count, 0));
	const average = lengths.reduce((sum, length) => sum + length, 0) / tools.length || 1;
	return tools
		.map((tool, index) => {
			let score = 0;
			for (const term of queryTerms) {
				const count = counts[index].get(term);
				if (!count) continue;
				const frequency = documentFrequencies.get(term)!;
				const idf = Math.log(1 + (tools.length - frequency + 0.5) / (frequency + 0.5));
				const norm = 1.2 * (0.25 + (0.75 * lengths[index]) / average);
				score += idf * ((count * 2.2) / (count + norm));
			}
			return { tool, score };
		})
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score)
		.map(({ tool }) => tool);
}

const searchMcpToolsSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		description:
			"BM25 keywords matching MCP tool names and descriptions. Use English keywords for tools described in English; empty queries do not list tools.",
	}),
});

export function createSearchMcpToolsDefinition(
	getTools: () => readonly AgentTool[],
): ToolDefinition<typeof searchMcpToolsSchema> {
	return {
		name: "search_mcp_tools",
		label: "Search MCP tools",
		description:
			"Find enabled MCP tools callable through codemode using BM25 keyword ranking. Returns up to 10 matches with their complete parameter and return-value declarations. Refine the keywords if there are no matches. This tool discovers declarations and does not call MCP tools.",
		promptSnippet: "Find MCP tool declarations using BM25 keyword search",
		promptGuidelines: [
			"Before calling an unfamiliar MCP tool, use search_mcp_tools to find its complete declaration, then call the returned tool name through codemode.",
		],
		parameters: searchMcpToolsSchema,
		execute: async (_id, { query }) => {
			const tools = rankTools(query, getTools())
				.slice(0, 10)
				.map((tool) => ({
					name: toCodemodeIdentifier(tool.name),
					description: renderToolSample({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.parameters as CodemodeJsonSchema,
						outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? { type: "string" },
					}),
				}));
			const result = { tools };
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result,
				details: undefined,
			};
		},
	};
}
