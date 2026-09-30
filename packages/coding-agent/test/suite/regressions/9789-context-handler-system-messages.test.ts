import type { AgentMessage } from "@candy/agent-core";
import { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@candy/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { useSummaryResponses } from "../summarization.ts";

function captureRequest(harness: Harness, text: string): () => TranscriptContext {
	let request: TranscriptContext | undefined;
	harness.setResponses([
		(context) => {
			request = context;
			return fauxAssistantMessage(text);
		},
	]);
	return () => {
		if (!request) throw new Error("expected a provider request");
		return request;
	};
}

function toolNames(context: TranscriptContext): string[] {
	return getCurrentTools(context.messages).map((tool) => tool.name);
}

async function compactSession(harness: Harness): Promise<void> {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
	await harness.session.execution.prompt("first");
	await harness.session.execution.prompt("second");
	useSummaryResponses(harness, [fauxAssistantMessage("summary"), fauxAssistantMessage("summary")]);
	await harness.session.execution.compact();
	expect(harness.session.execution.messages.map((message) => message.role).slice(0, 2)).toEqual([
		"system",
		"compactionSummary",
	]);
}

describe("context handlers and system messages", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	// Regression #9789, #9822: pruning from the compaction summary dropped the prompt and tool checkpoint.
	it("keeps the prompt and tools when a handler slices from the compaction summary", async () => {
		const seen: AgentMessage[][] = [];
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.on("context", async (event) => {
						seen.push(event.messages);
						const summary = event.messages.findIndex((message) => message.role === "compactionSummary");
						return { messages: event.messages.slice(summary) };
					});
				},
			],
		});
		harnesses.push(harness);
		await compactSession(harness);
		const getRequest = captureRequest(harness, "after compaction");

		await harness.session.execution.prompt("third");

		const request = getRequest();
		expect(seen.at(-1)?.some((message) => message.role === "system")).toBe(false);
		expect(request.messages[0]?.role).toBe("system");
		expect(toolNames(request)).toEqual(harness.session.execution.getActiveToolNames());
		expect(getCurrentSystemPrompt(request.messages)).toBe(harness.session.execution.systemPrompt);
		expect(request.messages.filter((message) => message.role === "system")).toHaveLength(1);
	});

	it("keeps mid-conversation system messages in place when a handler leaves the conversation unchanged", async () => {
		let turn = 0;
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.on("before_agent_start", (event) => {
						if (++turn === 2) event.systemPromptOptions.sections.plan_mode = "Plan only.";
					});
					candy.on("context", async (event) => ({ messages: event.messages }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one")]);
		await harness.session.execution.prompt("first");
		const getRequest = captureRequest(harness, "two");

		await harness.session.execution.prompt("second");

		const systemMessages = getRequest().messages.filter((message) => message.role === "system");
		expect(systemMessages).toHaveLength(2);
		expect(systemMessages[1]?.sections).toEqual({ plan_mode: "<plan_mode>\nPlan only.\n</plan_mode>" });
	});

	it("applies in-place edits to event.messages without a return value", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.on("context", async (event) => {
						event.messages.splice(0, 0, {
							role: "user",
							content: [{ type: "text", text: "injected" }],
							timestamp: 0,
						});
					});
				},
			],
		});
		harnesses.push(harness);
		const getRequest = captureRequest(harness, "done");

		await harness.session.execution.prompt("hello");

		const request = getRequest();
		expect(request.messages.map((message) => message.role)).toEqual(["system", "user", "user"]);
		expect(toolNames(request)).toEqual(harness.session.execution.getActiveToolNames());
	});

	it("keeps system messages a handler adds after the replayed head", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.on("context", async (event) => ({
						messages: [{ role: "system", content: "ephemeral reminder", timestamp: 0 }, ...event.messages],
					}));
				},
			],
		});
		harnesses.push(harness);
		const getRequest = captureRequest(harness, "done");

		await harness.session.execution.prompt("hello");

		const request = getRequest();
		expect(request.messages.map((message) => message.role)).toEqual(["system", "system", "user"]);
		expect(toolNames(request)).toEqual(harness.session.execution.getActiveToolNames());
		expect(getCurrentSystemPrompt(request.messages)).toContain(harness.session.execution.systemPrompt);
		expect(getCurrentSystemPrompt(request.messages)).toContain("ephemeral reminder");
	});
});
