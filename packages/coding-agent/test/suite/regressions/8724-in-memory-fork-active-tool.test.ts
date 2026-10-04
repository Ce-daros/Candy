import type { AgentTool, AgentToolResult } from "@candy/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@candy/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	assembleAgentSessionFromServices,
	type CreateAgentSessionRuntimeFactory,
} from "../../../src/core/agent-session-runtime.ts";
import { McpRuntime } from "../../../src/core/mcp/runtime.ts";
import { createHarness } from "../harness.ts";

describe("regression #8724: in-memory fork during an active tool turn", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("does not append the aborted turn to the replacement session", async () => {
		let markToolStarted = () => {};
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const blockingTool: AgentTool = {
			name: "block",
			label: "Block",
			description: "Wait until aborted",
			parameters: Type.Object({}),
			execute: (_toolCallId, _params, signal) =>
				new Promise<AgentToolResult<unknown>>((resolve) => {
					markToolStarted();
					signal?.addEventListener(
						"abort",
						() => resolve({ content: [{ type: "text", text: "tool aborted" }], details: {} }),
						{ once: true },
					);
				}),
		};
		const harness = await createHarness({ tools: [blockingTool] });
		const services: AgentSessionServices = {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.execution.modelRuntime,
			mcp: await McpRuntime.create({
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				settingsManager: harness.settingsManager,
			}),
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.execution.resourceLoader,
			diagnostics: [],
			dispose: async () => {},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => ({
			...(await assembleAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: harness.getModel(),
				noTools: "all",
			})),
			services,
			diagnostics: [],
		});
		const runtime = new AgentSessionRuntime(harness.session, services, createRuntime);
		cleanups.push(async () => {
			if (runtime.session !== harness.session) {
				await runtime.dispose();
			}
			await harness.cleanup();
		});

		harness.setResponses([
			fauxAssistantMessage("first response"),
			fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("unused after abort"),
		]);
		await runtime.session.execution.prompt("first prompt");
		const firstUserEntryId = runtime.session.history.getUserMessagesForForking()[0]?.entryId;
		expect(firstUserEntryId).toBeDefined();

		const outgoingPrompt = runtime.session.execution.prompt("start blocking tool");
		await toolStarted;
		const forkResult = await runtime.fork(firstUserEntryId!);
		await outgoingPrompt;
		await runtime.session.execution.bindExtensions({});

		expect(forkResult).toEqual({ cancelled: false, selectedText: "first prompt" });
		expect(runtime.session.execution.messages.map((message) => message.role)).toEqual(["system"]);
		expect(
			runtime.session.history
				.getEntries()
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.message.role),
		).toEqual(["system"]);

		let capturedRoles: string[] = [];
		harness.setResponses([
			(context) => {
				capturedRoles = context.messages.map((message) => message.role);
				return fauxAssistantMessage("next response");
			},
		]);
		await runtime.session.execution.prompt("next prompt");

		expect(capturedRoles).toEqual(["system", "system", "user"]);
	});
});
