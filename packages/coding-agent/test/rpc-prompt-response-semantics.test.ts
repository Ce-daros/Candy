import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@candy/agent-core";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@candy/ai";
import { getBuiltinModel as getModel } from "@candy/ai/providers/all";
import { EventStream } from "@candy/ai/utils/event-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { LoadExtensionsResult } from "../src/core/extensions/index.ts";
import type { PromptTemplate } from "../src/core/prompt-templates.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createInMemoryModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	extensionsResult?: LoadExtensionsResult;
	promptTemplates?: PromptTemplate[];
}): Promise<{
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRuntime = await createInMemoryModelRuntime(authStorage);
	if (options.withAuth) {
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: modelRuntime,
		resourceLoader: {
			...createTestResourceLoader({ extensionsResult: options.extensionsResult }),
			getPrompts: () => ({ prompts: options.promptTemplates ?? [], diagnostics: [] }),
		},
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			try {
				await session.abort();
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: Parameters<typeof createRuntimeHost>[0]): Promise<{
	lineHandler: (line: string) => void;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, cleanup };
}

describe("RPC prompt response semantics", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining(
						"No API key found for fake-provider.\n\nOpen Sources to configure provider authentication. See:",
					),
				});
			});
		} finally {
			await cleanup();
		}
	});

	// #9098: a successful prompt may start an agent run or be consumed by an extension.
	it("emits one started response for literal slash text", async () => {
		const runs: string[] = [];
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			extensionsResult: await createTestExtensionsResult([
				(candy) =>
					candy.registerCommand("handled", {
						handler: async (args) => {
							runs.push(args);
						},
					}),
			]),
		});

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "/handled argument" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
					data: { disposition: "started" },
				});
			});
			expect(runs).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	it("discovers same-name commands and executes each source through RPC", async () => {
		const runs: string[] = [];
		const template: PromptTemplate = {
			name: "handled",
			description: "Handled template",
			content: "Template $1",
			filePath: "/virtual/handled.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/handled.md", { source: "local" }),
		};
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			promptTemplates: [template],
			extensionsResult: await createTestExtensionsResult([
				(candy) => {
					candy.registerCommand("handled", {
						handler: async (args) => {
							runs.push(args);
						},
					});
					candy.on("input", (event) => {
						if (event.text === "handled input") return { action: "handled" };
					});
				},
			]),
		});

		try {
			lineHandler(JSON.stringify({ id: "commands", type: "get_commands" }));
			await vi.waitFor(() => {
				const response = parseOutputLines(rpcIo.outputLines).find((line) => line.id === "commands");
				expect(response).toMatchObject({
					success: true,
					data: {
						commands: [
							{ source: "extension", name: "handled" },
							{ source: "prompt", name: "handled" },
						],
					},
				});
			});
			lineHandler(
				JSON.stringify({
					id: "command",
					type: "execute_command",
					source: "extension",
					name: "handled",
					args: "extension",
				}),
			);
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "command",
					type: "response",
					command: "execute_command",
					success: true,
					data: { disposition: "handled" },
				});
			});
			expect(runs).toEqual(["extension"]);
			lineHandler(JSON.stringify({ id: "input", type: "prompt", message: "handled input" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "input")).toEqual([
					{ id: "input", type: "response", command: "prompt", success: true, data: { disposition: "handled" } },
				]);
			});
			expect(parseOutputLines(rpcIo.outputLines).filter((line) => line.type === "agent_start")).toHaveLength(0);
			lineHandler(
				JSON.stringify({
					id: "template",
					type: "execute_command",
					source: "prompt",
					name: "handled",
					args: "argument",
				}),
			);
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "template",
					type: "response",
					command: "execute_command",
					success: true,
					data: { disposition: "started" },
				});
			});
			await vi.waitFor(() =>
				expect(parseOutputLines(rpcIo.outputLines).some((line) => line.type === "agent_settled")).toBe(true),
			);
			lineHandler(JSON.stringify({ id: "messages", type: "get_messages" }));
			await vi.waitFor(() => {
				const response = parseOutputLines(rpcIo.outputLines).find((line) => line.id === "messages");
				expect(JSON.stringify(response)).toContain("Template argument");
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
					data: { disposition: "queued" },
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});

	// #9803: a handler can consume A while independently queueing B; report A's outcome.
	it.each(["steer", "follow_up"] as const)(
		"reports %s as handled even when an extension queues another message",
		async (type) => {
			const { lineHandler, cleanup } = await startRpcMode({
				withAuth: true,
				responseDelayMs: 500,
				extensionsResult: await createTestExtensionsResult([
					(candy) => {
						candy.on("input", (event) => {
							if (event.text === "A" && event.source === "rpc") {
								candy.sendUserMessage("B", { deliverAs: type === "steer" ? "steer" : "followUp" });
								return { action: "handled" };
							}
						});
					},
				]),
			});

			try {
				lineHandler(JSON.stringify({ id: "start", type: "prompt", message: "Start" }));
				await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, "start")).toHaveLength(1));

				lineHandler(JSON.stringify({ id: "A", type, message: "A" }));
				await vi.waitFor(() => {
					expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
						id: "A",
						type: "response",
						command: type,
						success: true,
						data: { disposition: "handled" },
					});
					expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
						type: "queue_update",
						steering: type === "steer" ? ["B"] : [],
						followUp: type === "follow_up" ? ["B"] : [],
					});
				});
				await vi.waitFor(() => {
					expect(
						parseOutputLines(rpcIo.outputLines).filter((line) => line.type === "response" && line.id === "A"),
					).toHaveLength(1);
				});
			} finally {
				await cleanup();
			}
		},
	);

	it.each(["steer", "follow_up"] as const)("reports %s as queued after input transformation", async (type) => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			extensionsResult: await createTestExtensionsResult([
				(candy) => {
					candy.on("input", (event) => {
						if (event.text === "A") return { action: "transform", text: "B" };
					});
				},
			]),
		});

		try {
			lineHandler(JSON.stringify({ id: "A", type, message: "A" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "A",
					type: "response",
					command: type,
					success: true,
					data: { disposition: "queued" },
				});
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					type: "queue_update",
					steering: type === "steer" ? ["B"] : [],
					followUp: type === "follow_up" ? ["B"] : [],
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("returns and clears queued steering and follow-up messages", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 500 });

		try {
			lineHandler(JSON.stringify({ id: "clear-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-start")).toHaveLength(1);
			});

			lineHandler(
				JSON.stringify({
					id: "clear-steering",
					type: "prompt",
					message: "Change direction",
					streamingBehavior: "steer",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-steering")).toMatchObject([
					{ data: { disposition: "queued" } },
				]);
			});

			lineHandler(
				JSON.stringify({
					id: "clear-follow-up",
					type: "prompt",
					message: "Summarize when finished",
					streamingBehavior: "followUp",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-follow-up")).toHaveLength(1);
			});

			lineHandler(JSON.stringify({ id: "clear", type: "clear_queue" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "clear",
					type: "response",
					command: "clear_queue",
					success: true,
					data: {
						steering: [{ text: "Change direction" }],
						followUp: [{ text: "Summarize when finished" }],
					},
				});
			});

			await sleep(600);
			expect(parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_start")).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});
});
