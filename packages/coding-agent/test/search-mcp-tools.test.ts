import type { AgentTool } from "@candy/agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createSearchMcpToolsDefinition } from "../src/core/search-mcp-tools.ts";

const makeTool = (name: string, description: string): AgentTool => ({
	name,
	description,
	label: name,
	parameters: Type.Object({ recordId: Type.String() }),
	outputSchema: Type.Object({ amount: Type.Number() }),
	execute: async () => {
		throw Error("Search must not execute MCP tools");
	},
});
async function search(tools: AgentTool[], query: string) {
	const result = await createSearchMcpToolsDefinition(() => tools).execute(
		"search",
		{ query },
		undefined,
		undefined,
		undefined as never,
	);
	return result.structuredContent as { tools: { name: string; description: string }[] };
}

describe("MCP BM25 search", () => {
	it("ranks rare matching keywords above a frequent common keyword", async () => {
		const result = await search(
			[
				makeTool("one", "query ".repeat(100)),
				makeTool("two", "query shipping"),
				makeTool("three", "query order"),
				makeTool("four", "unrelated document"),
			],
			"query shipping",
		);
		expect(result.tools.map((tool) => tool.name)).toEqual(["two", "one", "three"]);
	});
	it("normalizes document length in BM25 ranking", async () => {
		const result = await search(
			[makeTool("long", `record ${"filler ".repeat(100)}`), makeTool("short", "record")],
			"record",
		);
		expect(result.tools.map((tool) => tool.name)).toEqual(["short", "long"]);
	});
	it("returns full declarations under callable identifiers without executing tools", async () => {
		const result = await search([makeTool("mcp_fixture_record-lookup", "Find records")], "record lookup");
		expect(result.tools[0].name).toBe("mcp_fixture_record_lookup");
		expect(result.tools[0].description).toContain("recordId: string");
		expect(result.tools[0].description).toContain("amount: number");
	});
	it("limits results to 10 and returns no matches for unknown or empty keywords", async () => {
		const tools = Array.from({ length: 12 }, (_, index) => makeTool(`item_${index}`, "Search records"));
		expect((await search(tools, "records")).tools).toHaveLength(10);
		expect((await search(tools, "unmatched")).tools).toEqual([]);
		expect((await search(tools, " ")).tools).toEqual([]);
	});
});
