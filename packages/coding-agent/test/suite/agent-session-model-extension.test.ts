import type { AgentTool } from "@candy/agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, type JsonObject, type Usage } from "@candy/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildSystemPromptOptions, ExtensionAPI } from "../../src/index.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

describe("AgentSession model and extension characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("setModel saves the model to the session", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		const nextModel = harness.getModel("faux-2")!;
		const previousModelChanges = harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change");

		await harness.session.selection.setModel(nextModel);

		expect(harness.session.selection.model?.id).toBe("faux-2");
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => `${entry.provider}/${entry.modelId}`),
		).toEqual([
			...previousModelChanges.map((entry) => `${entry.provider}/${entry.modelId}`),
			`${nextModel.provider}/${nextModel.id}`,
		]);
		expect(harness.settingsManager.getDefaultProvider()).toBeUndefined();
		expect(harness.settingsManager.getDefaultModel()).toBeUndefined();
	});

	it("saves model and thinking defaults through explicit setting commits", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		const nextModel = harness.getModel("faux-2")!;

		await harness.session.selection.setModel(nextModel);
		expect(harness.settingsManager.getDefaultProvider()).toBeUndefined();
		expect(harness.settingsManager.getDefaultModel()).toBeUndefined();

		harness.session.selection.setThinkingLevel("low");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBeUndefined();

		await harness.settingsManager.commitDefaultModelAndProvider(nextModel.provider, nextModel.id);
		expect(harness.settingsManager.getDefaultProvider()).toBe(nextModel.provider);
		expect(harness.settingsManager.getDefaultModel()).toBe(nextModel.id);

		await harness.settingsManager.setDefaultThinkingLevel("high");
		harness.session.selection.setThinkingLevel("high");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("high");
	});

	it("keeps model application independent from a failed default save", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		await harness.session.selection.setModel(harness.getModel("faux-2")!);
		vi.spyOn(harness.settingsManager, "commitDefaultModelAndProvider").mockRejectedValueOnce(
			new Error("Settings write failed"),
		);

		await expect(harness.settingsManager.commitDefaultModelAndProvider("faux", "faux-2")).rejects.toThrow(
			"Settings write failed",
		);
		expect(harness.session.selection.model?.id).toBe("faux-2");
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "model_change")).toBe(true);
	});

	it("persists the requested default thinking level even when the current model clamps it", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: true }] });
		harnesses.push(harness);

		await harness.settingsManager.setDefaultThinkingLevel("max");
		harness.session.selection.setThinkingLevel("max");

		expect(harness.session.selection.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("max");
	});

	it("cycleThinkingLevel is session-only by default", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", name: "One", reasoning: true }],
			settings: {
				defaultProvider: "faux",
				defaultModel: "faux-1",
				defaultThinkingLevel: "low",
			},
		});
		harnesses.push(harness);

		harness.session.selection.setThinkingLevel("off");
		expect(harness.session.selection.cycleThinkingLevel()).toBe("minimal");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("low");
	});

	it("applies per-model thinking level override on model switch", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			settings: { defaultThinkingLevel: "medium" },
		});
		harnesses.push(harness);

		// Set a per-model override for faux-2
		await harness.settingsManager.setModelThinkingLevel("faux", "faux-2", "low");

		// Session starts on faux-1 with default thinking
		harness.session.selection.setThinkingLevel("high");
		expect(harness.session.selection.thinkingLevel).toBe("high");

		// Switch to faux-2 → per-model override should apply
		const model2 = harness.getModel("faux-2")!;
		await harness.session.selection.setModel(model2);
		expect(harness.session.selection.thinkingLevel).toBe("low");

		// Switch back to faux-1 → no per-model override, uses global default
		const model1 = harness.getModel("faux-1")!;
		await harness.session.selection.setModel(model1);
		expect(harness.session.selection.thinkingLevel).toBe("medium");
	});

	it("falls back to current session thinking level when no per-model or global default is configured", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);

		harness.session.selection.setThinkingLevel("high");
		await harness.session.selection.setModel(harness.getModel("faux-2")!);
		expect(harness.session.selection.thinkingLevel).toBe("high");
	});

	it("per-model override takes priority over global default during model switch", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			settings: {
				defaultThinkingLevel: "high",
				modelThinkingLevels: { "faux/faux-2": "minimal" },
			},
		});
		harnesses.push(harness);

		// Start on a non-thinking model, then switch to faux-2
		const model2 = harness.getModel("faux-2")!;
		await harness.session.selection.setModel(model2);
		expect(harness.session.selection.thinkingLevel).toBe("minimal");
	});

	it("clamps thinking levels to model capabilities and cycles available levels", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: false }] });
		harnesses.push(harness);

		harness.session.selection.setThinkingLevel("high");
		expect(harness.session.selection.thinkingLevel).toBe("off");
		expect(harness.session.selection.cycleThinkingLevel()).toBeUndefined();
	});

	it("cycles xhigh before max when both are supported", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: true }] });
		harnesses.push(harness);
		harness.getModel().thinkingLevelMap = { xhigh: "xhigh", max: "max" };

		expect(harness.session.selection.getAvailableThinkingLevels()).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		harness.session.selection.setThinkingLevel("high");
		expect(harness.session.selection.cycleThinkingLevel()).toBe("xhigh");
		expect(harness.session.selection.cycleThinkingLevel()).toBe("max");
		expect(harness.session.selection.cycleThinkingLevel()).toBe("off");
	});

	it("throws when setModel is called without configured auth", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			withConfiguredAuth: false,
		});
		harnesses.push(harness);

		await expect(harness.session.selection.setModel(harness.getModel("faux-2")!)).rejects.toThrow(
			`No API key for ${harness.getModel().provider}/faux-2`,
		);
	});

	it("keeps the latest model selection when an earlier auth check finishes later", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
		});
		harnesses.push(harness);
		let finishFirst!: (value: { source: string; type: "api_key" }) => void;
		let finishSecond!: (value: { source: string; type: "api_key" }) => void;
		let checkCount = 0;
		harness.session.execution.modelRuntime.checkAuth = () =>
			new Promise((resolve) => {
				if (checkCount++ === 0) finishFirst = resolve;
				else finishSecond = resolve;
			});

		const first = harness.session.selection.setModel(harness.getModel("faux-2")!);
		const second = harness.session.selection.setModel(harness.getModel("faux-3")!);
		finishSecond({ source: "test", type: "api_key" });
		await second;
		finishFirst({ source: "test", type: "api_key" });
		await first;

		expect(harness.session.selection.model?.id).toBe("faux-3");
	});

	it("commits a supported thinking level together with the selected model", async () => {
		const harness = await createHarness({
			models: [
				{ id: "reasoning", reasoning: true },
				{ id: "plain", reasoning: false },
			],
			settings: { defaultThinkingLevel: "max" },
		});
		harnesses.push(harness);
		await harness.session.selection.setModel(harness.getModel("plain")!);
		expect(harness.session.selection.thinkingLevel).toBe("off");
		expect(harness.sessionManager.buildSessionContext().thinkingLevel).toBe("off");
		await harness.session.selection.setModel(harness.getModel("reasoning")!);
		expect(harness.session.selection.thinkingLevel).toBe("high");
		expect(harness.sessionManager.buildSessionContext().thinkingLevel).toBe("high");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("max");
	});

	it("rejects thinking changes after disposal without appending a journal entry", async () => {
		const harness = await createHarness({ models: [{ id: "reasoning", reasoning: true }] });
		harnesses.push(harness);
		await harness.session.execution.dispose();
		const entries = harness.sessionManager.getEntries();
		expect(() => harness.session.selection.setThinkingLevel("high")).toThrow("Session was disposed");
		expect(harness.sessionManager.getEntries()).toEqual(entries);
	});

	it("does not restore a pending model selection after clearModel", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
		harnesses.push(harness);
		let finishAuth!: (value: { source: string; type: "api_key" }) => void;
		harness.session.execution.modelRuntime.checkAuth = () =>
			new Promise((resolve) => {
				finishAuth = resolve;
			});

		const pendingSelection = harness.session.selection.setModel(harness.getModel("faux-2")!);
		harness.session.selection.clearModel();
		finishAuth({ source: "test", type: "api_key" });
		await pendingSelection;

		expect(harness.session.selection.model).toBeUndefined();
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.at(-1)?.modelId,
		).toBe("faux-1");
	});

	it("allows extension tool_call handlers to block tool execution", async () => {
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
					candy.on("tool_call", async () => ({ block: true, reason: "Blocked by test" }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const errorText =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(errorText);
			},
		]);

		await harness.session.execution.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("Blocked by test");
		expect(
			harness.session.execution.messages.find((message) => message.role === "toolResult" && message.isError),
		).toBeDefined();
	});

	it("allows extension tool_result handlers to modify tool results", async () => {
		const toolUsage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const patchedToolUsage: Usage = {
			input: 5,
			output: 6,
			cacheRead: 7,
			cacheWrite: 8,
			totalTokens: 26,
			cost: { input: 0.5, output: 0.6, cacheRead: 0.7, cacheWrite: 0.8, total: 2.6 },
		};
		let observedToolUsage: Usage | undefined;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text }], details: { text }, usage: toolUsage };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(candy) => {
					candy.on("tool_result", async (event) => {
						observedToolUsage = event.usage;
						return {
							content: [{ type: "text", text: "patched result" }],
							details: { patched: true },
							usage: patchedToolUsage,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const text =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(text);
			},
		]);

		await harness.session.execution.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("patched result");
		const toolResult = harness.session.execution.messages.find(
			(message) =>
				message.role === "toolResult" &&
				typeof message.details === "object" &&
				message.details !== null &&
				!Array.isArray(message.details) &&
				(message.details as JsonObject).patched === true,
		);
		expect(observedToolUsage).toEqual(toolUsage);
		expect(toolResult).toBeDefined();
		expect(toolResult?.role === "toolResult" ? toolResult.usage : undefined).toEqual(patchedToolUsage);
	});

	it("allows extension context handlers to modify messages before the LLM call", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.on("context", async (event) => ({
						messages: event.messages.map((message) =>
							message.role === "user"
								? { ...message, content: [{ type: "text", text: "rewritten" }], timestamp: message.timestamp }
								: message,
						),
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerUserText = "";
		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText =
					user && typeof user.content !== "string"
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.execution.prompt("original");

		expect(providerUserText).toBe("rewritten");
		const storedUserMessage = harness.session.execution.messages.find((message) => message.role === "user");
		expect(storedUserMessage?.role).toBe("user");
		if (storedUserMessage?.role === "user") {
			expect(storedUserMessage.content).toEqual([{ type: "text", text: "original" }]);
		}
	});

	it("allows extension input handlers to transform or handle input", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const transformedHarness = await createHarness({
			extensionFactories: [
				(candy) => {
					extensionApi = candy;
					candy.on("input", async (event) => {
						if (event.text === "ping") {
							return { action: "handled" };
						}
						return { action: "transform", text: `transformed:${event.text}` };
					});
				},
			],
		});
		harnesses.push(transformedHarness);
		let providerUserText = "";
		transformedHarness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText =
					user && typeof user.content !== "string"
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await transformedHarness.session.execution.prompt("hello");
		await transformedHarness.session.execution.prompt("ping");

		expect(providerUserText).toBe("transformed:hello");
		expect(transformedHarness.session.execution.messages.filter((message) => message.role === "user")).toHaveLength(
			1,
		);
		expect(extensionApi).toBeDefined();
	});

	it("allows extension commands to inspect live system prompt options", async () => {
		const seenOptions: BuildSystemPromptOptions[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.registerCommand("inspect-options", {
						description: "Inspect system prompt options",
						handler: async (_args, ctx) => {
							const options = ctx.getSystemPromptOptions();
							seenOptions.push(options);
							options.selectedTools?.push("mutated_tool");
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.execution.executeCommand({ source: "extension", name: "inspect-options", args: "" });
		await harness.session.execution.executeCommand({ source: "extension", name: "inspect-options", args: "" });

		expect(seenOptions).toHaveLength(2);
		expect(seenOptions[0]).toBe(seenOptions[1]);
		expect(seenOptions[0]?.cwd).toBe(harness.tempDir);
		expect(seenOptions[0]?.selectedTools).toContain("read");
		expect(seenOptions[1]?.selectedTools).toContain("mutated_tool");
	});

	it("allows before_agent_start handlers to inject custom messages and modify the system prompt", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.on("before_agent_start", async (event) => ({
						message: {
							customType: "before-start",
							content: "injected",
							display: true,
							details: { injected: true },
						},
						systemPrompt: `${event.systemPrompt}\n\nextra instructions`,
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerSystemPrompt = "";
		let sawInjectedUserMessage = false;
		harness.setResponses([
			(context) => {
				providerSystemPrompt = getCurrentSystemPrompt(context.messages);
				sawInjectedUserMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "injected"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.execution.prompt("hello");

		expect(providerSystemPrompt).toContain("extra instructions");
		expect(sawInjectedUserMessage).toBe(true);
		expect(
			harness.session.execution.messages.some(
				(message) => message.role === "custom" && message.customType === "before-start",
			),
		).toBe(true);
	});

	it("bindExtensions emits session_start and reload emits session_shutdown then session_start", async () => {
		const lifecycleEvents: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.on("session_start", async (event) => {
						lifecycleEvents.push(`start:${event.reason}`);
					});
					candy.on("session_shutdown", async (event) => {
						lifecycleEvents.push(`shutdown:${event.reason}`);
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.execution.bindExtensions({ shutdownHandler: () => {} });
		await harness.session.execution.reload();

		expect(lifecycleEvents).toEqual(["start:startup", "shutdown:reload", "start:reload"]);
	});
	it("keeps extension contexts usable when resource loading fails", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const runner = harness.session.execution.extensionRunner;
		const context = runner.createContext();
		const reload = vi
			.spyOn(harness.session.execution.resourceLoader, "reload")
			.mockRejectedValueOnce(new Error("resource load failed"));
		await expect(harness.session.resources.reload()).rejects.toThrow("resource load failed");
		expect(harness.session.execution.extensionRunner).toBe(runner);
		expect(context.history.getSessionId()).toBe(harness.session.history.getSessionId());
		harness.setResponses([fauxAssistantMessage("still usable")]);
		await harness.session.execution.prompt("continue");
		expect(harness.session.history.getLastAssistantText()).toBe("still usable");
		reload.mockRestore();
	});
});
