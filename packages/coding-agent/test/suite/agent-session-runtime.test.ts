import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@candy/ai/providers/faux";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assembleAgentSessionFromServices,
	assembleAgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createRuntimeFromFactory,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionHistory } from "../../src/core/session-history.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/index.ts";
import { extensionHostModules } from "../../src/presentation/extensions/virtual-modules.ts";
import { resourceThemeAdapter } from "../../src/presentation/resource-theme-adapter.ts";
import { configuredFauxProvider } from "../ai.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime characterization", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		vi.restoreAllMocks();
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		options?: { cwd?: string; bootstrapModel?: boolean; injectModelRuntime?: boolean },
	) {
		const tempDir =
			options?.cwd ?? join(tmpdir(), `pi-runtime-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = fauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const injectedModelRuntime = options?.injectModelRuntime
			? await ModelRuntime.create({ credentials: authStorage, modelsPath: join(tempDir, "models.json") })
			: undefined;
		injectedModelRuntime?.registerNativeProvider(configuredFauxProvider(faux));

		const runtimeOptions = {
			agentDir: tempDir,
			...(injectedModelRuntime
				? { modelRuntime: injectedModelRuntime }
				: { modelRuntimeOptions: { credentials: authStorage } }),
			model: options?.bootstrapModel === false ? undefined : faux.getModel(),
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
		};
		let failNextRuntimeCreation = false;
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			if (failNextRuntimeCreation) {
				failNextRuntimeCreation = false;
				throw new Error("runtime factory failed");
			}
			const services = await assembleAgentSessionServices({
				extensionModules: extensionHostModules,
				themeAdapter: resourceThemeAdapter,
				...runtimeOptions,
				cwd,
			});
			return {
				...(await assembleAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createRuntimeFromFactory(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionHistory.create(tempDir, join(tempDir, "sessions")),
		});
		await runtime.session.execution.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			await injectedModelRuntime?.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return {
			runtime,
			modelRuntime: injectedModelRuntime,
			faux,
			tempDir,
			failNextRuntimeCreation() {
				failNextRuntimeCreation = true;
			},
		};
	}

	it("runs every disposal step in order and reports their errors in one flat list", async () => {
		const phases: string[] = [];
		const { runtime, tempDir } = await createRuntimeForTest((candy) => {
			candy.on("session_shutdown", (event) => {
				expect(event).toStrictEqual({ type: "session_shutdown", reason: "quit" });
				phases.push("shutdown");
			});
		});
		cleanups.pop();
		cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
		const abortError = new Error("abort failed");
		const invalidationError = new Error("invalidation failed");
		const executionError = new Error("execution disposal failed");
		const servicesError = new Error("services disposal failed");
		const execution = runtime.session.execution;
		const abort = execution.abort.bind(execution);
		const disposeExecution = execution.dispose.bind(execution);
		const disposeServices = runtime.services.dispose.bind(runtime.services);
		vi.spyOn(execution, "abort").mockImplementation(async () => {
			phases.push("abort");
			await abort();
			throw abortError;
		});
		runtime.setBeforeSessionInvalidate(() => {
			phases.push("invalidate");
			throw invalidationError;
		});
		vi.spyOn(execution, "dispose").mockImplementation(async () => {
			phases.push("execution");
			await disposeExecution();
			throw executionError;
		});
		vi.spyOn(runtime.services, "dispose").mockImplementation(async () => {
			phases.push("services");
			await disposeServices();
			throw servicesError;
		});

		const disposal = runtime.dispose();
		await expect(disposal).rejects.toMatchObject({
			message: "Session runtime disposal failed",
			errors: [abortError, invalidationError, executionError, servicesError],
		});
		expect(phases).toEqual(["abort", "shutdown", "invalidate", "execution", "services"]);
		expect(runtime.dispose()).toBe(disposal);
	});

	it("reports outgoing cleanup errors without replacing the session", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const session = runtime.session;
		const error = new Error("invalidation failed");
		runtime.setBeforeSessionInvalidate(() => {
			throw error;
		});

		await expect(runtime.newSession()).rejects.toMatchObject({
			message: "Outgoing session cleanup failed",
			errors: [error],
		});
		expect(runtime.session).toBe(session);
		runtime.setBeforeSessionInvalidate(undefined);
	});

	it("preserves the current session when replacement creation fails", async () => {
		const { runtime, failNextRuntimeCreation } = await createRuntimeForTest(() => {});
		const originalSession = runtime.session;
		const rebound: unknown[] = [];
		runtime.setRebindSession(async (session) => {
			rebound.push(session);
		});
		failNextRuntimeCreation();

		await expect(runtime.newSession()).rejects.toThrow("runtime factory failed");

		expect(runtime.session).toBe(originalSession);
		expect(originalSession.execution.isDisposed).toBe(false);
		expect(rebound).toEqual([]);
	});

	it("disposes cwd-owned model runtime after a committed session replacement", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const outgoingModelRuntime = runtime.services.modelRuntime;

		await runtime.newSession();

		expect(runtime.session.execution.isDisposed).toBe(false);
		expect(() => outgoingModelRuntime.refresh()).toThrow("Model runtime is disposed");
		await expect(runtime.services.modelRuntime.refresh()).resolves.toMatchObject({ aborted: false });
	});

	it("preserves the current session when resume runtime creation fails", async () => {
		const { runtime, failNextRuntimeCreation } = await createRuntimeForTest(() => {});
		await runtime.session.execution.prompt("hello");
		const originalSession = runtime.session;
		const sessionFile = originalSession.history.getSessionFile()!;
		failNextRuntimeCreation();

		await expect(runtime.switchSession(sessionFile)).rejects.toThrow("runtime factory failed");
		expect(runtime.session).toBe(originalSession);
		expect(originalSession.execution.isDisposed).toBe(false);
	});

	it("preserves the current session when fork runtime creation fails", async () => {
		const { runtime, failNextRuntimeCreation } = await createRuntimeForTest(() => {});
		await runtime.session.execution.prompt("hello");
		const originalSession = runtime.session;
		const userMessage = originalSession.history.getUserMessagesForForking()[0]!;
		failNextRuntimeCreation();

		await expect(runtime.fork(userMessage.entryId)).rejects.toThrow("runtime factory failed");
		expect(runtime.session).toBe(originalSession);
		expect(originalSession.execution.isDisposed).toBe(false);
	});

	it("preserves the current session when replacement setup fails", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const originalSession = runtime.session;
		const rebound: unknown[] = [];
		runtime.setRebindSession(async (session) => {
			rebound.push(session);
		});

		await expect(
			runtime.newSession({
				setup: async () => {
					throw new Error("new-session setup failed");
				},
			}),
		).rejects.toThrow("new-session setup failed");

		expect(runtime.session).toBe(originalSession);
		expect(originalSession.execution.isDisposed).toBe(false);
		expect(rebound).toEqual([]);
	});

	it("removes a candidate log written by a failed new-session setup", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const original = runtime.session;
		let candidateFile: string | undefined;
		await expect(
			runtime.newSession({
				setup: async (candidate) => {
					candidateFile = candidate.getSessionFile();
					candidate.appendMessage({ role: "user", content: "candidate", timestamp: Date.now() });
					throw new Error("setup rejected");
				},
			}),
		).rejects.toThrow("setup rejected");
		expect(candidateFile).toBeDefined();
		expect(existsSync(candidateFile!)).toBe(false);
		expect(runtime.session).toBe(original);
		expect(original.execution.isDisposed).toBe(false);
	});

	it("removes a prepared fork log when candidate construction fails", async () => {
		const { runtime, failNextRuntimeCreation } = await createRuntimeForTest(() => {});
		await runtime.session.execution.prompt("source");
		const original = runtime.session;
		const directory = original.history.getSessionDir();
		const files = readdirSync(directory);
		const user = original.history.getUserMessagesForForking()[0]!;
		failNextRuntimeCreation();
		await expect(runtime.fork(user.entryId, { position: "at" })).rejects.toThrow("runtime factory failed");
		expect(readdirSync(directory)).toEqual(files);
		expect(runtime.session).toBe(original);
		expect(original.execution.isDisposed).toBe(false);
	});

	it("removes only the imported copy when candidate construction fails", async () => {
		const { runtime, tempDir, failNextRuntimeCreation } = await createRuntimeForTest(() => {});
		await runtime.session.execution.prompt("current");
		const original = runtime.session;
		const directory = original.history.getSessionDir();
		const files = readdirSync(directory);
		const source = SessionHistory.create(tempDir, join(tempDir, "import-source"));
		source.appendMessage({ role: "user", content: "imported", timestamp: Date.now() });
		const sourcePath = source.getSessionFile()!;
		const contents = readFileSync(sourcePath, "utf8");
		failNextRuntimeCreation();
		await expect(runtime.importFromJsonl(sourcePath)).rejects.toThrow("runtime factory failed");
		expect(readdirSync(directory)).toEqual(files);
		expect(readFileSync(sourcePath, "utf8")).toBe(contents);
		expect(runtime.session).toBe(original);
		expect(original.execution.isDisposed).toBe(false);
	});

	it("settles the active response before session replacement", async () => {
		let toolStarted!: () => void;
		const toolStartedPromise = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const { runtime, faux } = await createRuntimeForTest((candy: ExtensionAPI) => {
			candy.registerTool({
				name: "block",
				label: "Block",
				description: "Blocks until aborted",
				parameters: Type.Object({}),
				execute: (_toolCallId, _params, signal) =>
					new Promise<AgentToolResult<unknown>>((resolve) => {
						toolStarted();
						signal?.addEventListener("abort", () =>
							resolve({ content: [{ type: "text", text: "tool aborted" }], details: {} }),
						);
					}),
			});
		});

		await runtime.session.execution.prompt("hello");
		const firstSessionFile = runtime.session.execution.sessionFile!;
		await runtime.newSession();
		await runtime.session.execution.bindExtensions({});

		faux.setResponses([fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" })]);
		const outgoingSession = runtime.session;
		const promptPromise = outgoingSession.execution.prompt("start blocking tool");
		await toolStartedPromise;

		const switchResult = await runtime.switchSession(firstSessionFile);
		await promptPromise;

		expect(switchResult.cancelled).toBe(false);
		expect(runtime.session.execution.sessionFile).toBe(firstSessionFile);
		// The outgoing session settled before replacement: the interrupted tool
		// call has a persisted tool result instead of dangling forever.
		const outgoingEntries = SessionHistory.open(outgoingSession.history.getSessionFile()!)
			.getEntries()
			.filter((entry) => entry.type === "message");
		expect(outgoingEntries.map((entry) => entry.message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it("preserves an existing session when importing a file with the same name", async () => {
		const { runtime, tempDir } = await createRuntimeForTest(() => {});
		const sessionDir = runtime.session.history.getSessionDir();
		const importDir = join(tempDir, "import");
		const filename = "collision.jsonl";
		const storedPath = join(sessionDir, filename);
		const importPath = join(importDir, filename);
		const storedSession = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "stored",
			timestamp: new Date().toISOString(),
			cwd: tempDir,
		})}\n`;
		const importedSession = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "imported",
			timestamp: new Date().toISOString(),
			cwd: tempDir,
		})}\n`;
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(importDir, { recursive: true });
		writeFileSync(storedPath, storedSession);
		writeFileSync(importPath, importedSession);

		await runtime.importFromJsonl(importPath);

		expect(readFileSync(storedPath, "utf8")).toBe(storedSession);
		expect(runtime.session.execution.sessionFile).not.toBe(storedPath);
		expect(readFileSync(runtime.session.execution.sessionFile!, "utf8")).toContain('"id":"imported"');
	});

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtime } = await createRuntimeForTest((candy: ExtensionAPI) => {
			candy.on("session_before_switch", (event) => {
				events.push(event);
			});
			candy.on("session_shutdown", (event) => {
				events.push(event);
			});
			candy.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtime.session.execution.prompt("hello");
		const originalSessionFile = runtime.session.execution.sessionFile;
		const originalSession = runtime.session;

		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.execution.bindExtensions({});
		expect(runtime.session).not.toBe(originalSession);
		expect(runtime.session.execution.messages).toEqual([]);
		const secondSessionFile = runtime.session.execution.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;

		const switchResult = await runtime.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtime.session.execution.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("leaves an injected ModelRuntime owned by its caller", async () => {
		const { runtime, modelRuntime } = await createRuntimeForTest(() => {}, { injectModelRuntime: true });
		expect(modelRuntime).toBeDefined();

		await runtime.dispose();

		await expect(modelRuntime!.refresh()).resolves.toMatchObject({ aborted: false });
	});

	it("invalidates the outgoing extension context after shutdown and before rebind", async () => {
		const phases: string[] = [];
		const { runtime } = await createRuntimeForTest((candy) => {
			candy.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtime.session;
		runtime.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.execution.extensionRunner.createContext().cwd).toBe(oldSession.history.getCwd());
		});
		runtime.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtime.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.execution.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload.",
		);
		runtime.setBeforeSessionInvalidate(undefined);
		runtime.setRebindSession(undefined);
	});

	it("honors session_before_switch cancellation for new and resume", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelReason: "new" | "resume" | undefined;
		const { runtime, tempDir } = await createRuntimeForTest((candy: ExtensionAPI) => {
			candy.on("session_before_switch", (event) => {
				events.push(event);
				if (event.reason === cancelReason) {
					return { cancel: true };
				}
			});
			candy.on("session_start", (event) => {
				events.push(event);
			});
		});

		await runtime.session.execution.prompt("hello");
		const originalSession = runtime.session;
		const originalSessionFile = runtime.session.execution.sessionFile;
		const rebound: unknown[] = [];
		runtime.setRebindSession(async (session) => {
			rebound.push(session);
		});

		cancelReason = "new";
		const newResult = await runtime.newSession();
		expect(newResult.cancelled).toBe(true);
		expect(runtime.session).toBe(originalSession);
		expect(originalSession.execution.isDisposed).toBe(false);
		expect(rebound).toEqual([]);
		expect(runtime.session.execution.sessionFile).toBe(originalSessionFile);

		events.length = 0;
		const otherDir = join(tempDir, "other-project");
		mkdirSync(otherDir, { recursive: true });
		const otherSession = SessionHistory.create(otherDir, join(tempDir, "other-sessions"));
		otherSession.appendMessage({ role: "user", content: [{ type: "text", text: "other" }], timestamp: Date.now() });
		const otherSessionFile = otherSession.getSessionFile();
		cancelReason = "resume";
		const resumeResult = await runtime.switchSession(otherSessionFile!);
		expect(resumeResult.cancelled).toBe(true);
		expect(runtime.session.execution.sessionFile).toBe(originalSessionFile);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtime } = await createRuntimeForTest((candy: ExtensionAPI) => {
			candy.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			candy.on("session_shutdown", (event) => {
				events.push(event);
			});
			candy.on("session_start", (event) => {
				events.push(event);
			});
		});

		events.length = 0;
		await runtime.session.execution.prompt("hello");
		const userMessage = runtime.session.history.getUserMessagesForForking()[0]!;
		const previousSessionFile = runtime.session.execution.sessionFile;

		const successResult = await runtime.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtime.session.execution.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtime.session.execution.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);
		const sessionFileName = parse(runtime.session.execution.sessionFile!).name;
		expect(sessionFileName.endsWith(`_${runtime.session.execution.sessionId}`)).toBe(true);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtime.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtime.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});

	it("reports why an unflushed session cannot be forked", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const sessionFile = runtime.session.execution.sessionFile;
		const leafId = runtime.session.history.getLeafId();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(false);
		expect(leafId).toBeTruthy();

		await expect(runtime.fork(leafId!, { position: "at" })).rejects.toThrow(
			"This session has not been saved yet. Send a message before cloning or forking it.",
		);
	});

	it("clones the current active branch into a persisted session", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.execution.prompt("hello");
		await runtime.session.execution.prompt("again");

		const beforeMessages = runtime.session.execution.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const previousSessionFile = runtime.session.execution.sessionFile;
		const result = await runtime.clone();
		expect(result).toEqual({ cancelled: false });
		expect(runtime.session.execution.sessionFile).not.toBe(previousSessionFile);
		expect(
			runtime.session.execution.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("clones the current active branch in memory", async () => {
		const tempDir = join(tmpdir(), `pi-runtime-suite-in-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = fauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const runtimeOptions = {
			agentDir: tempDir,
			modelRuntimeOptions: { credentials: authStorage },
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [
					(candy: ExtensionAPI) => {
						candy.registerProvider(configuredFauxProvider(faux));
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await assembleAgentSessionServices({
				extensionModules: extensionHostModules,
				themeAdapter: resourceThemeAdapter,
				...runtimeOptions,
				cwd,
			});
			return {
				...(await assembleAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createRuntimeFromFactory(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionHistory.inMemory(tempDir),
		});
		await runtime.session.execution.bindExtensions({});
		cleanups.push(async () => {
			await runtime.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await runtime.session.execution.prompt("hello");
		await runtime.session.execution.prompt("again");

		const beforeMessages = runtime.session.execution.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		expect(runtime.session.execution.sessionFile).toBeUndefined();

		const result = await runtime.clone();
		expect(result).toEqual({ cancelled: false });
		expect(runtime.session.execution.sessionFile).toBeUndefined();
		expect(
			runtime.session.execution.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("throws when forking with an invalid entry id", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await expect(runtime.fork("missing-entry")).rejects.toThrow("Invalid entry ID for forking");
	});

	it("keeps the current session when an extension cancels cloning", async () => {
		const events: SessionBeforeForkEvent[] = [];
		const { runtime } = await createRuntimeForTest((candy) => {
			candy.on("session_before_fork", (event) => {
				events.push(event);
				return { cancel: true };
			});
		});
		await runtime.session.execution.prompt("hello");
		const original = runtime.session;
		const leafId = original.history.getLeafId();

		expect(await runtime.clone()).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: leafId, position: "at" }]);
		expect(runtime.session).toBe(original);
		expect(original.execution.isDisposed).toBe(false);
	});

	it("updates the runtime session cwd on cross-cwd session replacement", async () => {
		const firstDir = join(tmpdir(), `pi-runtime-cwd-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const secondDir = join(tmpdir(), `pi-runtime-cwd-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, { cwd: firstDir });
		const otherAuthStorage = AuthStorage.inMemory();
		await otherAuthStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const otherRuntimeOptions = {
			agentDir: tempDir,
			modelRuntimeOptions: { credentials: otherAuthStorage },
			resourceLoaderOptions: {
				extensionFactories: [
					(candy: ExtensionAPI) => {
						candy.registerProvider(configuredFauxProvider(faux));
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await assembleAgentSessionServices({
				extensionModules: extensionHostModules,
				themeAdapter: resourceThemeAdapter,
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await assembleAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createRuntimeFromFactory(createOtherRuntime, {
			cwd: secondDir,
			agentDir: tempDir,
			sessionManager: SessionHistory.create(secondDir, join(tempDir, "second-sessions")),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.execution.prompt("other");
		const otherSessionFile = otherRuntime.session.execution.sessionFile!;

		await runtime.switchSession(otherSessionFile);

		expect(realpathSync(runtime.session.history.getCwd())).toBe(realpathSync(secondDir));
		expect(realpathSync(runtime.cwd)).toBe(realpathSync(secondDir));
	});

	it("restores model and thinking state from the destination session", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, {
			bootstrapModel: false,
		});
		const otherDir = join(tempDir, "other");
		mkdirSync(otherDir, { recursive: true });
		const otherAuthStorage = AuthStorage.inMemory();
		await otherAuthStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const otherRuntimeOptions = {
			agentDir: tempDir,
			modelRuntimeOptions: { credentials: otherAuthStorage },
			resourceLoaderOptions: {
				extensionFactories: [
					(candy: ExtensionAPI) => {
						candy.registerProvider(configuredFauxProvider(faux));
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await assembleAgentSessionServices({
				extensionModules: extensionHostModules,
				themeAdapter: resourceThemeAdapter,
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await assembleAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createRuntimeFromFactory(createOtherRuntime, {
			cwd: otherDir,
			agentDir: tempDir,
			sessionManager: SessionHistory.create(otherDir, join(tempDir, "other-sessions")),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.selection.setModel(faux.getModel("faux-2")!);
		otherRuntime.session.selection.setThinkingLevel("off");
		await otherRuntime.session.execution.prompt("hello");
		const targetSessionFile = otherRuntime.session.execution.sessionFile!;

		await runtime.switchSession(targetSessionFile);

		expect(runtime.session.selection.model?.id).toBe("faux-2");
		expect(runtime.session.selection.thinkingLevel).toBe("off");
	});
});
