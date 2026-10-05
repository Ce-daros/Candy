import {
	createInitialSystemMessage,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	toToolDeclaration,
} from "@candy/ai";
import { type FauxProviderHandle, fauxProvider } from "@candy/ai/providers/faux";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent, AgentInputs, type AgentMessage } from "../src/index.ts";
import { calculateTool } from "./utils/calculate.ts";

function createAgent(faux: FauxProviderHandle, history: AgentMessage[] = []) {
	const inputs = new AgentInputs();
	const agent = new Agent({
		streamFn: faux.provider.streamSimple,
		initialState: { model: faux.getModel(), thinkingLevel: "low", tools: [calculateTool] },
		inputs,
		host: {
			messages: () => history.slice(),
			async commit(message) {
				await Promise.resolve();
				history.push(message);
				return { message, entryId: `entry-${history.length}` };
			},
			reset: () => {
				history.length = 0;
			},
		},
	});
	return { agent, history, inputs };
}

describe("Agent integration with faux provider", () => {
	it("commits a tool workflow and consumes host history and queued follow-ups", async () => {
		const faux = fauxProvider({ models: [{ id: "faux-reasoning", reasoning: true }] });
		const initial = createInitialSystemMessage("Use the calculator for math.", [toToolDeclaration(calculateTool)]);
		const { agent, history, inputs } = createAgent(faux, initial ? [initial] : []);
		const events: AgentEvent["type"][] = [];
		const pending: Array<{ type: AgentEvent["type"]; ids: string[] }> = [];
		agent.subscribe((event) => {
			events.push(event.type);
			if (event.type === "message_end") {
				expect(history.at(-1)).toBe(event.message);
				expect(event.entryId).toBe(`entry-${history.length}`);
			}
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				pending.push({ type: event.type, ids: [...agent.state.pendingToolCalls] });
			}
		});
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxThinking("Multiply with the calculator."),
					fauxText("Let me calculate that."),
					fauxToolCall("calculate", { expression: "123 * 456" }, { id: "calc-1" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The result is 56088."),
			(context) => {
				expect(context.messages.map((message) => message.role)).toEqual([
					"system",
					"user",
					"assistant",
					"toolResult",
					"assistant",
					"user",
				]);
				expect(context.messages[3]).toMatchObject({
					role: "toolResult",
					content: [{ type: "text", text: "123 * 456 = 56088" }],
				});
				return fauxAssistantMessage("Your name is Alice; the result was 56088.");
			},
		]);
		inputs.followUp({ role: "user", content: "What is my name and the result?", timestamp: Date.now() });
		await agent.prompt("My name is Alice. Calculate 123 * 456.");
		expect(history.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"user",
			"assistant",
		]);
		expect(history[2]).toMatchObject({
			content: [
				{ type: "thinking", thinking: "Multiply with the calculator." },
				{ type: "text", text: "Let me calculate that." },
				{ type: "toolCall", id: "calc-1", name: "calculate", arguments: { expression: "123 * 456" } },
			],
		});
		expect(history.at(-1)).toMatchObject({
			content: [{ type: "text", text: "Your name is Alice; the result was 56088." }],
		});
		expect(pending).toEqual([
			{ type: "tool_execution_start", ids: ["calc-1"] },
			{ type: "tool_execution_end", ids: [] },
		]);
		expect(events[0]).toBe("agent_start");
		expect(events.at(-1)).toBe("agent_end");
		expect(events.indexOf("turn_start")).toBeLessThan(events.indexOf("message_start"));
		expect(events.indexOf("message_update")).toBeLessThan(events.lastIndexOf("turn_end"));
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.messages).toEqual(history);
		expect(inputs.getQueuedInputs()).toEqual({ steering: [], followUp: [] });
	});

	it("aborts streaming and accepts the next prompt", async () => {
		const faux = fauxProvider({ tokensPerSecond: 20, tokenSize: { min: 2, max: 2 } });
		const { agent, history } = createAgent(faux);
		faux.setResponses([fauxAssistantMessage("one two three four five six seven eight nine")]);
		const unsubscribe = agent.subscribe((event) => {
			if (event.type === "message_update") agent.abort();
		});
		await agent.prompt("Count slowly.");
		unsubscribe();
		expect(history.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(agent.state.errorMessage).toBeDefined();
		expect(agent.state.isStreaming).toBe(false);
		faux.setResponses([fauxAssistantMessage("Recovered.")]);
		await agent.prompt("Try again.");
		expect(history.at(-1)).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Recovered." }] });
		expect(agent.state.errorMessage).toBeUndefined();
		expect(agent.state.isStreaming).toBe(false);
	});

	it.each(["user", "toolResult"] as const)("continues from a committed %s message", async (role) => {
		const faux = fauxProvider();
		const history: AgentMessage[] = [
			{
				role: "system",
				content: "Use the calculator for math.",
				toolsAdded: [toToolDeclaration(calculateTool)],
				timestamp: Date.now(),
			},
			{ role: "user", content: "What is 5 + 3?", timestamp: Date.now() },
		];
		if (role === "toolResult") {
			history.push(
				fauxAssistantMessage(fauxToolCall("calculate", { expression: "5 + 3" }, { id: "calc-1" }), {
					stopReason: "toolUse",
				}),
				{
					role: "toolResult",
					toolCallId: "calc-1",
					toolName: "calculate",
					content: [{ type: "text", text: "5 + 3 = 8" }],
					isError: false,
					timestamp: Date.now(),
				},
			);
		}
		const { agent } = createAgent(faux, history);
		const initialLength = history.length;
		faux.setResponses([fauxAssistantMessage("The answer is 8.")]);
		await agent.continue();
		expect(history).toHaveLength(initialLength + 1);
		expect(history.at(-1)).toMatchObject({ content: [{ type: "text", text: "The answer is 8." }] });
		expect(agent.state.isStreaming).toBe(false);
	});

	it.each(["empty", "assistant"] as const)(
		"rejects an invalid %s continuation without changing history",
		async (tail) => {
			const faux = fauxProvider();
			const history: AgentMessage[] = tail === "empty" ? [] : [fauxAssistantMessage("Hello.")];
			const { agent } = createAgent(faux, history);
			const before = history.slice();
			await expect(agent.continue()).rejects.toThrow(
				tail === "empty" ? "No messages to continue from" : "Cannot continue from message role: assistant",
			);
			expect(history).toEqual(before);
			expect(agent.state.isStreaming).toBe(false);
		},
	);
});
