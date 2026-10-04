import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runToolCall } from "../src/agent-loop.ts";
import type { AgentEvent, AgentTool } from "../src/types.ts";

const message = {
	role: "assistant" as const,
	content: [],
	api: "openai-responses" as const,
	provider: "openai",
	model: "test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop" as const,
	timestamp: 0,
};

const model = {
	id: "test",
	name: "test",
	api: "openai-responses" as const,
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"] as ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

describe("runToolCall", () => {
	it("validates and blocks nested calls through the same before hook", async () => {
		let executions = 0;
		const tool: AgentTool = {
			name: "query",
			label: "Query",
			description: "Query",
			parameters: Type.Object({ id: Type.Number() }),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "done" }], details: undefined };
			},
		};
		const context = { messages: [], tools: [tool] };
		const events: AgentEvent[] = [];
		const base = {
			assistantMessage: message,
			context,
			parentToolCallId: "parent",
			emit: (event: AgentEvent) => {
				events.push(event);
				return undefined;
			},
		};
		const invalid = await runToolCall({
			...base,
			toolCall: { type: "toolCall", id: "bad", name: "query", arguments: { id: "wrong" } },
			config: { model },
		});
		expect(invalid.isError).toBe(true);
		expect(executions).toBe(0);
		const blocked = await runToolCall({
			...base,
			toolCall: { type: "toolCall", id: "blocked", name: "query", arguments: { id: 1 } },
			config: { model, beforeToolCall: async ({ parentToolCallId }) => ({ block: parentToolCallId === "parent" }) },
		});
		expect(blocked.isError).toBe(true);
		expect(executions).toBe(0);
		expect(events.every((event) => !event.type.startsWith("message_"))).toBe(true);
		expect(
			events.filter((event) => event.type === "tool_execution_end").map((event) => event.parentToolCallId),
		).toEqual(["parent", "parent"]);
	});

	it("preserves structured content and applies after hooks", async () => {
		const tool: AgentTool = {
			name: "query",
			label: "Query",
			description: "Query",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: undefined, structuredContent: { value: 1 } }),
		};
		const outcome = await runToolCall({
			toolCall: { type: "toolCall", id: "nested", name: "query", arguments: {} },
			assistantMessage: message,
			context: { messages: [], tools: [tool] },
			config: { model, afterToolCall: async () => ({ structuredContent: { value: 2 }, isError: true }) },
		});
		expect(outcome.result.structuredContent).toEqual({ value: 2 });
		expect(outcome.isError).toBe(true);
	});
});
