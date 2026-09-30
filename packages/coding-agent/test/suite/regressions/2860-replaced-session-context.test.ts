import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@candy/ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	assembleAgentSessionFromServices,
	assembleAgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createRuntimeFromFactory,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { createSessionCommandActions } from "../../../src/core/session-command-actions.ts";
import { SessionHistory } from "../../../src/core/session-history.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "../../../src/index.ts";
import { extensionHostModules } from "../../../src/presentation/extensions/virtual-modules.ts";
import { resourceThemeAdapter } from "../../../src/presentation/resource-theme-adapter.ts";
import { configuredFauxProvider } from "../../ai.ts";

function getText(message: AgentSession["execution"]["messages"][number]): string {
	if (!("content" in message)) {
		return "";
	}
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("");
}

describe("regression #2860: replaced session callbacks", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(extensionFactory: ExtensionFactory, responses: string[]) {
		const tempDir = join(tmpdir(), `pi-2860-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = fauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await assembleAgentSessionServices({
				extensionModules: extensionHostModules,
				themeAdapter: resourceThemeAdapter,
				cwd,
				agentDir: tempDir,
				modelRuntime,
				resourceLoaderOptions: {
					extensionFactories: [
						(candy: ExtensionAPI) => {
							candy.registerProvider(configuredFauxProvider(faux));
							extensionFactory(candy);
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await assembleAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createRuntimeFromFactory(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionHistory.create(tempDir),
		});

		const rebindSession = async (): Promise<void> => {
			const session = runtime.session;
			await session.execution.bindExtensions({
				commandContextActions: createSessionCommandActions(runtime),
			});
		};

		runtime.setRebindSession(async () => {
			await rebindSession();
		});
		await rebindSession();

		cleanups.push(async () => {
			await runtime.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux };
	}

	it("rebinds before withSession, targets the replacement session, and invalidates stale pi/ctx", async () => {
		const events: string[] = [];
		let oldCtx: ExtensionCommandContext | undefined;
		let oldPi: ExtensionAPI | undefined;
		let oldSessionFile: string | undefined;
		let staleCtxThrows = false;
		let staleCandyThrows = false;
		let replacementSessionFile: string | undefined;
		let instanceId = 0;
		const { runtime } = await createRuntimeForTest(
			(candy) => {
				const currentInstance = ++instanceId;
				candy.on("session_start", () => {
					events.push(`start:${currentInstance}`);
				});
				candy.on("session_shutdown", () => {
					events.push(`shutdown:${currentInstance}`);
				});
				candy.registerCommand("repro", {
					description: "repro",
					handler: async (_args, ctx) => {
						oldCtx = ctx;
						oldPi = candy;
						oldSessionFile = ctx.history.getSessionFile();
						await ctx.newSession({
							parentSession: oldSessionFile,
							withSession: async (replacedCtx) => {
								events.push(`with:${currentInstance}`);
								replacementSessionFile = replacedCtx.history.getSessionFile();
								try {
									oldCtx?.history.getSessionFile();
								} catch {
									staleCtxThrows = true;
								}
								try {
									oldPi?.sendUserMessage("stale message");
								} catch {
									staleCandyThrows = true;
								}
								await replacedCtx.sendUserMessage("Hello from the new session!");
							},
						});
					},
				});
			},
			["hello reply"],
		);

		expect(events).toEqual(["start:1"]);

		await runtime.session.execution.executeCommand({ source: "extension", name: "repro", args: "" });

		expect(events).toEqual(["start:1", "shutdown:1", "start:2", "with:1"]);
		expect(replacementSessionFile).toBeDefined();
		expect(replacementSessionFile).not.toBe(oldSessionFile);
		expect(staleCtxThrows).toBe(true);
		expect(staleCandyThrows).toBe(true);
		expect(
			runtime.session.execution.messages
				.filter((message) => message.role !== "system")
				.map((message) => `${message.role}:${getText(message)}`),
		).toEqual(["user:Hello from the new session!", "assistant:hello reply"]);
	});

	it("supports withSession for fork", async () => {
		const { runtime } = await createRuntimeForTest(
			(candy) => {
				candy.registerCommand("fork-it", {
					description: "fork-it",
					handler: async (_args, ctx) => {
						const leafId = ctx.history.getLeafId();
						if (!leafId) {
							throw new Error("Missing leaf id");
						}
						await ctx.fork(leafId, {
							position: "at",
							withSession: async (replacedCtx) => {
								await replacedCtx.sendUserMessage("fork callback message");
							},
						});
					},
				});
			},
			["seed reply", "fork reply"],
		);

		await runtime.session.execution.prompt("seed");
		await runtime.session.execution.executeCommand({ source: "extension", name: "fork-it", args: "" });

		expect(
			runtime.session.execution.messages
				.filter((message) => message.role !== "system")
				.map((message) => `${message.role}:${getText(message)}`),
		).toEqual(["user:seed", "assistant:seed reply", "user:fork callback message", "assistant:fork reply"]);
	});

	it("supports withSession for switchSession", async () => {
		let targetSessionPath = "";
		const { runtime } = await createRuntimeForTest(
			(candy) => {
				candy.registerCommand("switch-it", {
					description: "switch-it",
					handler: async (_args, ctx) => {
						await ctx.switchSession(targetSessionPath, {
							withSession: async (replacedCtx) => {
								await replacedCtx.sendUserMessage("switch callback message");
							},
						});
					},
				});
			},
			["root reply", "target reply", "switch reply"],
		);

		await runtime.session.execution.prompt("root");
		const originalSessionPath = runtime.session.execution.sessionFile;
		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.execution.prompt("target");
		targetSessionPath = runtime.session.execution.sessionFile!;
		await runtime.switchSession(originalSessionPath!);

		await runtime.session.execution.executeCommand({ source: "extension", name: "switch-it", args: "" });

		expect(runtime.session.execution.sessionFile).toBe(targetSessionPath);
		expect(
			runtime.session.execution.messages
				.filter((message) => message.role !== "system")
				.map((message) => `${message.role}:${getText(message)}`),
		).toEqual(["user:target", "assistant:target reply", "user:switch callback message", "assistant:switch reply"]);
	});
});
