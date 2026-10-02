/** Boundary checks for extension-produced messages and session history. */

import type { AgentToolResult } from "@candy/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@candy/ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { type SessionEntry, sessionEntryToContextMessages } from "../../src/core/session-history.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { createHarness } from "./harness.ts";

function messageEntry(message: Record<string, unknown>): SessionEntry {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	} as unknown as SessionEntry;
}

describe("lax message content handling", () => {
	it("normalizes tool results from untyped tools that omit content", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(candy) => {
				candy.registerTool({
					name: "web_search",
					label: "Web Search",
					description: "Custom tool that returns a result without content",
					parameters: Type.Object({}),
					// Simulate an untyped JS extension tool that omits content.
					execute: async () => ({ details: {} }) as unknown as AgentToolResult<unknown>,
				});
			},
		];
		const harness = await createHarness({ extensionFactories });

		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("web_search", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.execution.prompt("search something");

			const toolResults = harness.session.execution.messages.filter((message) => message.role === "toolResult");
			expect(toolResults).toHaveLength(1);
			expect(toolResults[0].content).toEqual([]);
			// The follow-up turn consumed the normalized tool result without crashing.
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects null content in custom messages from extensions", async () => {
		const harness = await createHarness();

		try {
			await expect(
				harness.session.execution.sendCustomMessage({
					customType: "test",
					content: null as unknown as string,
					display: false,
					details: undefined,
				}),
			).rejects.toThrow("must contain text or content parts");
			expect(harness.session.execution.messages.some((message) => message.role === "custom")).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps valid message content untouched when loading session entries", async () => {
		const [message] = sessionEntryToContextMessages(
			messageEntry({ role: "user", content: "hello", timestamp: Date.now() }),
		);
		expect(message).toMatchObject({ role: "user", content: "hello" });
	});
});
