import type { AgentTool } from "@candy/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@candy/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

describe("#5998 blocked tool termination", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("lets a tool_call handler terminate the run after blocking execution", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(candy) => {
					candy.on("tool_call", async () => ({
						block: true,
						reason: "Blocked by terminating policy",
						terminate: true,
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("should not run"),
		]);

		await harness.session.execution.prompt("hi");

		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getAssistantTexts(harness)).not.toContain("should not run");
		expect(harness.eventsOfType("tool_execution_end")[0]?.result).toHaveProperty("terminate", true);
		expect(
			harness.session.execution.messages.find((message) => message.role === "toolResult" && message.isError),
		).toBeDefined();
	});
});
