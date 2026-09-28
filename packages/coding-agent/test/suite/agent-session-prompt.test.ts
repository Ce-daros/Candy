import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@candy/agent-core";
import { fauxAssistantMessage, fauxToolCall, type Model } from "@candy/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, InputEvent } from "../../src/core/extensions/index.ts";
import type { PromptTemplate } from "../../src/core/prompt-templates.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const processImage = vi.hoisted(() =>
	vi.fn(async (_bytes: Uint8Array, mimeType: string) => ({
		ok: true as const,
		data: Buffer.from("normalized").toString("base64"),
		mimeType,
		hints: [],
	})),
);
vi.mock("../../src/utils/image-process.ts", () => ({ processImage }));

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

async function createPausedCommandCompaction(
	outcome: "success" | "cancel",
	holdFirstCommand?: { started: () => void; released: Promise<void> },
) {
	let startCompaction = () => {};
	const started = new Promise<void>((resolve) => {
		startCompaction = resolve;
	});
	let releaseCompaction = () => {};
	const released = new Promise<void>((resolve) => {
		releaseCompaction = resolve;
	});
	const extensionsResult = await createTestExtensionsResult([
		(candy) => {
			candy.on("session_before_compact", async (event) => {
				startCompaction();
				await released;
				if (outcome === "cancel") return { cancel: true };
				return {
					compaction: {
						summary: "compacted",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				};
			});
			if (holdFirstCommand)
				candy.on("input", async (event) => {
					if (event.text === "Expanded first") {
						holdFirstCommand.started();
						await holdFirstCommand.released;
					}
				});
		},
	]);
	const template: PromptTemplate = {
		name: "queued",
		description: "Queued prompt",
		content: "Expanded $1",
		filePath: "/virtual/queued.md",
		sourceInfo: createSyntheticSourceInfo("/virtual/queued.md", { source: "local" }),
	};
	const resourceLoader = {
		...createTestResourceLoader({ extensionsResult }),
		getPrompts: () => ({ prompts: [template], diagnostics: [] }),
	};
	const harness = await createHarness({ resourceLoader, settings: { compaction: { keepRecentTokens: 1 } } });
	harness.setResponses([
		fauxAssistantMessage("one"),
		fauxAssistantMessage("two"),
		fauxAssistantMessage("three"),
		fauxAssistantMessage("four"),
	]);
	await harness.session.prompt("first");
	await harness.session.prompt("second");
	const compactPromise = harness.session.compact();
	await started;
	return { harness, compactPromise, releaseCompaction };
}

describe("AgentSession prompt characterization", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		processImage.mockClear();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("prompts while idle and records a single text response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
		expect(getMessageText(harness.session.messages[1]!)).toBe("hi");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("handles a tool call turn and waits for the follow-up LLM response", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		expect(toolRuns).toEqual(["hello"]);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(harness.session.messages[3]?.role).toBe("toolResult");
		expect(harness.session.messages[4]?.role).toBe("assistant");
	});

	it("executes multiple tool calls from one response and continues with a single follow-up response", async () => {
		const toolRuns: string[] = [];
		const makeTool = (name: string, delayMs: number): AgentTool => ({
			name,
			label: name,
			description: `${name} tool`,
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => {
				const value =
					typeof params === "object" && params !== null && "value" in params ? String(params.value) : "";
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				toolRuns.push(`${name}:${value}`);
				return {
					content: [{ type: "text", text: `${name}:${value}` }],
					details: { value },
				};
			},
		});
		const harness = await createHarness({ tools: [makeTool("slow", 25), makeTool("fast", 0)] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", { value: "a" }), fauxToolCall("fast", { value: "b" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				const toolResults = context.messages.filter((message) => message.role === "toolResult");
				return fauxAssistantMessage(`tool results: ${toolResults.length}`);
			},
		]);

		await harness.session.prompt("run tools");

		expect(toolRuns.sort()).toEqual(["fast:b", "slow:a"]);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("assistant");
	});

	it("preserves image attachments in the provider context", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawImage = false;

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				sawImage =
					user?.role === "user" &&
					typeof user.content !== "string" &&
					user.content.some((part) => part.type === "image");
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("describe", {
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: "ZmFrZQ==",
				},
			],
		});

		expect(sawImage).toBe(true);
	});

	// Regression test for https://github.com/earendil-works/pi/issues/9631
	it("uses the model selected by before_agent_start for image normalization", async () => {
		let strictModel: Model<string> | undefined;
		const harness = await createHarness({
			models: [{ id: "wide" }, { id: "strict" }],
			extensionFactories: [
				(candy) => {
					candy.on("before_agent_start", async () => {
						if (!strictModel) throw new Error("Expected strict model");
						await candy.setModel(strictModel);
					});
				},
			],
		});
		harnesses.push(harness);
		strictModel = harness.getModel("strict");
		if (!strictModel) throw new Error("Expected strict model");
		const resizeOptions = { maxWidth: 1000, maxHeight: 1000, maxBytes: 500000, jpegQuality: 70 };
		strictModel.inputLimits = { images: { resize: resizeOptions } };
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("inspect", {
			images: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
		});

		expect(harness.session.model?.id).toBe("strict");
		expect(processImage).toHaveBeenCalledWith(expect.any(Uint8Array), "image/png", {
			autoResizeImages: true,
			resizeOptions,
		});
		const userMessage = harness.session.messages.find((message) => message.role === "user");
		expect(userMessage?.content).toContainEqual({
			type: "image",
			data: Buffer.from("normalized").toString("base64"),
			mimeType: "image/png",
		});
	});

	it("executes a skill explicitly while keeping slash text literal", async () => {
		const tempDir = join(tmpdir(), `pi-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const skillPath = join(tempDir, "test-skill.md");
		writeFileSync(skillPath, "# Test Skill\n\nUse the skill body.");

		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({
				skills: [
					{
						name: "test",
						description: "Test skill",
						filePath: skillPath,
						disableModelInvocation: false,
						baseDir: tempDir,
						sourceInfo: createSyntheticSourceInfo(skillPath, {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: tempDir,
						}),
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
			(context) => {
				const users = context.messages.filter((message) => message.role === "user");
				expandedPrompt = getMessageText(users[users.length - 1]!);
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/test explain this");
		expect(expandedPrompt).toBe("/test explain this");
		await harness.session.executeCommand({ source: "skill", name: "test", args: "explain this" });

		expect(expandedPrompt).toContain('<skill name="test" location="');
		expect(expandedPrompt).toContain("Use the skill body.");
		expect(expandedPrompt).toContain("explain this");
	});

	it("executes prompt templates explicitly", async () => {
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Review this code: $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.executeCommand({ source: "prompt", name: "review", args: "src/index.ts" });

		expect(expandedPrompt).toBe("Review this code: src/index.ts");
	});

	it("uses source and name to disambiguate commands", async () => {
		const extensionRuns: string[] = [];
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Template: $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", { source: "local" }),
		};
		const extensionsResult = await createTestExtensionsResult([
			(candy) =>
				candy.registerCommand("review", {
					handler: async (args) => {
						extensionRuns.push(args);
					},
				}),
		]);
		const resourceLoader = {
			...createTestResourceLoader({ extensionsResult }),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		expect(
			harness.session
				.getCommands()
				.filter((command) => command.name === "review")
				.map((command) => command.source),
		).toEqual(["extension", "prompt"]);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.executeCommand({ source: "extension", name: "review", args: "extension arg" });
		await harness.session.executeCommand({ source: "prompt", name: "review", args: "prompt-arg" });
		expect(extensionRuns).toEqual(["extension arg"]);
		expect(getMessageText(harness.session.messages.find((message) => message.role === "user")!)).toBe(
			"Template: prompt-arg",
		);
		await expect(harness.session.executeCommand({ source: "prompt", name: "missing", args: "" })).rejects.toThrow(
			"Unknown prompt command: missing",
		);
	});

	it("sendUserMessage keeps a matching command literal", async () => {
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Review this code: $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.sendUserMessage("/review src/index.ts");

		expect(expandedPrompt).toBe("/review src/index.ts");
	});

	it("dispatches extension commands without consuming a provider response", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("should stay queued")]);

		await harness.session.executeCommand({ source: "extension", name: "testcmd", args: "hello world" });

		expect(commandRuns).toEqual(["hello world"]);
		expect(harness.session.messages).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("extension sendUserMessage keeps command text literal", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					extensionApi = candy;
					candy.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		expect(extensionApi).toBeDefined();
		harness.setResponses([fauxAssistantMessage("ok")]);

		extensionApi?.sendUserMessage("/testcmd hello world");

		await vi.waitFor(() =>
			expect(harness.session.messages.some((message) => message.role === "assistant")).toBe(true),
		);
		expect(commandRuns).toEqual([]);
		expect(getMessageText(harness.session.messages.find((message) => message.role === "user")!)).toBe(
			"/testcmd hello world",
		);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("sendUserMessage while idle triggers a turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("response")]);

		await harness.session.sendUserMessage("from extension");

		expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
		expect(getMessageText(harness.session.messages[1]!)).toBe("from extension");
	});

	it("does not report streamingBehavior to input handlers while idle", async () => {
		const inputEvents: InputEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(candy) => {
					candy.on("input", (event) => {
						inputEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("idle", { streamingBehavior: "followUp" });

		expect(inputEvents).toHaveLength(1);
		expect(inputEvents[0]?.streamingBehavior).toBeUndefined();
	});

	it("reports streamingBehavior to input handlers while streaming", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const inputEvents: InputEvent[] = [];
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(candy) => {
					candy.on("input", (event) => {
						inputEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;
		await harness.session.prompt("queued", { streamingBehavior: "followUp" });

		expect(inputEvents.map((event) => event.streamingBehavior)).toEqual([undefined, "followUp"]);

		releaseToolExecution?.();
		await promptPromise;
	});

	it("throws when prompted during streaming without a streamingBehavior", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;

		await expect(harness.session.prompt("second")).rejects.toThrow(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);

		releaseToolExecution?.();
		await promptPromise;
	});

	it("throws when prompted during manual compaction", async () => {
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(candy) => {
					candy.on("session_before_compact", async (event) => {
						markCompactionStarted();
						await compactionReleased;
						return {
							compaction: {
								summary: "manual compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const compactPromise = harness.session.compact();
		await compactionStarted;

		try {
			await expect(harness.session.prompt("third")).rejects.toThrow(
				"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
			);
		} finally {
			releaseCompaction();
			await compactPromise;
		}
	});

	it("executes extensions immediately and queues explicit text commands during compaction", async () => {
		let startCompaction = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			startCompaction = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const extensionRuns: string[] = [];
		const skillDir = join(tmpdir(), `candy-command-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(skillDir, { recursive: true });
		tempDirs.push(skillDir);
		const skillPath = join(skillDir, "review.md");
		writeFileSync(skillPath, "# Review\n\nCheck this carefully.");
		const extensionsResult = await createTestExtensionsResult([
			(candy) => {
				candy.registerCommand("review", {
					handler: async (args) => {
						extensionRuns.push(args);
					},
				});
				candy.on("session_before_compact", async (event) => {
					startCompaction();
					await compactionReleased;
					return {
						compaction: {
							summary: "compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
			},
		]);
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Template $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", { source: "local" }),
		};
		const resourceLoader = {
			...createTestResourceLoader({ extensionsResult }),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
			getSkills: () => ({
				skills: [
					{
						name: "review",
						description: "Review skill",
						filePath: skillPath,
						disableModelInvocation: false,
						baseDir: skillDir,
						sourceInfo: createSyntheticSourceInfo(skillPath, { source: "local" }),
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createHarness({ resourceLoader, settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("three"),
			fauxAssistantMessage("four"),
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const compactPromise = harness.session.compact();
		await compactionStarted;
		const dispositions: string[] = [];
		try {
			await harness.session.executeCommand({ source: "extension", name: "review", args: "now" });
			expect(extensionRuns).toEqual(["now"]);
			const promptPromise = harness.session.executeCommand(
				{ source: "prompt", name: "review", args: "prompt" },
				{
					preflightResult: (result) => {
						dispositions.push(result);
					},
				},
			);
			const skillPromise = harness.session.executeCommand(
				{ source: "skill", name: "review", args: "skill" },
				{
					preflightResult: (result) => {
						dispositions.push(result);
					},
				},
			);
			expect(dispositions).toEqual(["queued", "queued"]);
			expect(harness.getPendingResponseCount()).toBe(2);
			releaseCompaction();
			await compactPromise;
			await Promise.all([promptPromise, skillPromise]);
			const userMessages = harness.session.messages.filter((message) => message.role === "user").map(getMessageText);
			expect(userMessages.slice(-2)[0]).toBe("Template prompt");
			expect(userMessages.slice(-2)[1]).toContain("Check this carefully.\n</skill>\n\nskill");
		} finally {
			releaseCompaction();
		}
	});

	it.each(["abort", "cancel"] as const)("settles queued commands after compaction %s", async (outcome) => {
		const { harness, compactPromise, releaseCompaction } = await createPausedCommandCompaction(
			outcome === "cancel" ? "cancel" : "success",
		);
		harnesses.push(harness);
		const dispositions: string[] = [];
		const commandPromise = harness.session.executeCommand(
			{ source: "prompt", name: "queued", args: outcome },
			{
				preflightResult: (result) => {
					dispositions.push(result);
				},
			},
		);
		expect(dispositions).toEqual(["queued"]);
		expect(harness.session.pendingMessageCount).toBe(1);
		try {
			if (outcome === "abort") harness.session.abortCompaction();
			releaseCompaction();
			await expect(compactPromise).rejects.toThrow("Compaction cancelled");
			await commandPromise;
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(harness.session.messages.filter((message) => message.role === "user").map(getMessageText)).toContain(
				`Expanded ${outcome}`,
			);
		} finally {
			releaseCompaction();
		}
	});

	it("clearQueue cancels a command accepted during compaction and returns its text", async () => {
		const { harness, compactPromise, releaseCompaction } = await createPausedCommandCompaction("success");
		harnesses.push(harness);
		const commandPromise = harness.session.executeCommand(
			{ source: "prompt", name: "queued", args: "clear" },
			{ streamingBehavior: "steer" },
		);
		expect(harness.session.pendingMessageCount).toBe(1);
		expect(harness.session.getSteeringMessages()).toEqual(["Expanded clear"]);
		expect(harness.session.clearQueue()).toEqual({ steering: ["Expanded clear"], followUp: [] });
		await commandPromise;
		expect(harness.session.pendingMessageCount).toBe(0);
		try {
			releaseCompaction();
			await compactPromise;
			expect(harness.getPendingResponseCount()).toBe(2);
		} finally {
			releaseCompaction();
		}
	});

	it("does not run remaining compaction commands after session disposal", async () => {
		let markInputStarted = () => {};
		const inputStarted = new Promise<void>((resolve) => {
			markInputStarted = resolve;
		});
		let releaseInput = () => {};
		const inputReleased = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		const { harness, compactPromise, releaseCompaction } = await createPausedCommandCompaction("success", {
			started: markInputStarted,
			released: inputReleased,
		});
		harnesses.push(harness);
		const first = harness.session.executeCommand({ source: "prompt", name: "queued", args: "first" });
		const second = harness.session.executeCommand({ source: "prompt", name: "queued", args: "second" });
		const firstResult = first.then(
			() => "ran",
			(error: Error) => error.message,
		);
		const secondResult = second.then(
			() => "ran",
			(error: Error) => error.message,
		);
		try {
			releaseCompaction();
			await compactPromise;
			await inputStarted;
			harness.session.dispose();
			releaseInput();
			expect(await firstResult).toContain("disposed");
			expect(await secondResult).toContain("disposed");
			expect(
				harness.session.messages.filter((message) => message.role === "user").map(getMessageText),
			).not.toContain("Expanded second");
		} finally {
			releaseCompaction();
			releaseInput();
		}
	});

	it("throws when prompting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.clearModel();

		await expect(harness.session.prompt("hi")).rejects.toThrow("No model selected.");
	});

	it("throws when prompting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.prompt("hi")).rejects.toThrow(
			`No API key found for ${harness.getModel().provider}.`,
		);
	});
});
