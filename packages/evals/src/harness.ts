import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { AgentMessage } from "@candy/agent-core";
import { contentText, InMemoryCredentialStore } from "@candy/ai";
import { getCurrentSystemPrompt } from "@candy/ai/utils/transcript";
import {
	type AgentSession,
	type CreateAgentSessionRuntimeOptions,
	createAgentSessionRuntime,
	getAgentDir,
	ModelRuntime,
	ReadOnlyAuthStorage,
	SessionHistory,
} from "@candy/coding-agent";

import {
	attachHarnessRunToError,
	createHarness,
	type Harness,
	type HarnessContext,
	type JsonValue,
	normalizeHarnessRun,
	normalizeRecord,
	type SimpleHarnessResult,
	type TranscriptEvent,
	toJsonValue,
	type UsageSummary,
} from "vitest-evals/harness";

export const CANDY_SESSION_SNAPSHOT_ARTIFACT = "piSessionJsonl";

type CandyRunDiagnostics = {
	events: TranscriptEvent[];
	usage: UsageSummary;
};

export type CandyCodingAgentInput = string | Array<{ type: "prompt"; content: string } | { type: "reload" }>;

export type CandyCodingAgentModelSelection = {
	provider: string;
	id: string;
};

export type CandyCodingAgentHarnessOptions = {
	name?: string;
	model?: CandyCodingAgentModelSelection;
	noTools?: CreateAgentSessionRuntimeOptions["noTools"];
	tools?: CreateAgentSessionRuntimeOptions["tools"];
	customTools?: CreateAgentSessionRuntimeOptions["customTools"];
	workspaceFiles?: Readonly<Record<string, string>>;
};

export type CandyCodingAgentHarnessWithOutput<TOutput extends JsonValue> = CandyCodingAgentHarnessOptions & {
	output: (args: {
		response: string;
		session: AgentSession;
		systemPrompt: string;
		agentDir: string;
	}) => TOutput | Promise<TOutput>;
};

export function resolveModelSelection(
	explicitModel: CandyCodingAgentModelSelection | undefined,
	environment: { CANDY_PROVIDER?: string; CANDY_MODEL?: string } = process.env,
): CandyCodingAgentModelSelection {
	const provider = (explicitModel?.provider ?? environment.CANDY_PROVIDER)?.trim();
	const id = (explicitModel?.id ?? environment.CANDY_MODEL)?.trim();
	if (!provider || !id) {
		throw new Error("Select a harness model explicitly or set both CANDY_PROVIDER and CANDY_MODEL as defaults.");
	}
	return { provider, id };
}

export function applyIsolatedEnvironment(home: string, agentDir: string): () => void {
	const overrides = { HOME: home, USERPROFILE: home, CANDY_CODING_AGENT_DIR: agentDir };
	const previous = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(overrides)) {
		previous.set(name, process.env[name]);
		process.env[name] = value;
	}
	return () => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

function toTranscriptEvents(
	messages: ReturnType<AgentSession["history"]["buildSessionContext"]>["messages"],
): TranscriptEvent[] {
	const events: TranscriptEvent[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			events.push({ type: "message", role: "user", content: contentText(message.content) });
			continue;
		}
		if (message.role === "assistant") {
			const text = contentText(message.content);
			if (text) events.push({ type: "message", role: "assistant", content: text });
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				events.push({
					type: "tool_call",
					id: part.id,
					name: part.name,
					arguments: normalizeRecord(part.arguments),
				});
			}
			continue;
		}
		if (message.role === "toolResult") {
			const text = contentText(message.content);
			events.push({
				type: "tool_result",
				toolCallId: message.toolCallId,
				name: message.toolName,
				content: message.content.every((part) => part.type === "text") ? text : toJsonValue(message.content),
				...(message.isError ? { error: { message: text || "Tool failed" } } : {}),
			});
		}
	}
	return events;
}

async function seedWorkspace(workspace: string, files: Readonly<Record<string, string>> | undefined): Promise<void> {
	for (const [name, content] of Object.entries(files ?? {})) {
		if (!name || isAbsolute(name)) throw new TypeError(`Invalid workspace fixture path: ${name}`);
		const path = resolve(workspace, name);
		const pathFromWorkspace = relative(workspace, path);
		if (pathFromWorkspace === ".." || pathFromWorkspace.startsWith(`..${sep}`) || isAbsolute(pathFromWorkspace)) {
			throw new TypeError(`Workspace fixture escapes the workspace: ${name}`);
		}
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, { mode: 0o600 });
	}
}

function getCommittedMessages(session: AgentSession): AgentMessage[] {
	return session.history.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

async function promptAgent(session: AgentSession, input: string, signal: AbortSignal | undefined): Promise<string> {
	signal?.throwIfAborted();
	const previousMessageCount = getCommittedMessages(session).length;
	await session.execution.prompt(input);
	const assistant = getCommittedMessages(session)
		.slice(previousMessageCount)
		.reverse()
		.find((message) => message.role === "assistant");
	if (!assistant) throw new Error("Agent run completed without an assistant message.");
	if (assistant.stopReason !== "stop" && assistant.stopReason !== "toolUse") {
		throw new Error(
			assistant.errorMessage ?? `Agent run ended with unexpected stop reason: ${assistant.stopReason}.`,
		);
	}
	const output = session.history.getLastAssistantText();
	if (!output && assistant.stopReason === "stop") throw new Error("Agent run produced no assistant text.");
	return output ?? "";
}

async function runCandyCodingAgent<TOutput extends JsonValue>(
	input: CandyCodingAgentInput,
	signal: AbortSignal | undefined,
	setArtifact: HarnessContext["setArtifact"],
	options: CandyCodingAgentHarnessOptions | CandyCodingAgentHarnessWithOutput<TOutput>,
): Promise<SimpleHarnessResult<string | TOutput>> {
	const startedAt = performance.now();
	signal?.throwIfAborted();
	const selection = resolveModelSelection(options.model);
	const hostAgentDir = getAgentDir();
	const root = await mkdtemp(join(tmpdir(), "pi-eval-"));
	const workspace = join(root, "workspace");
	const isolatedHome = join(root, "home");
	const agentDir = join(isolatedHome, ".candy", "agent");
	let sessionManager: SessionHistory | undefined;
	let session: AgentSession | undefined;
	let modelRuntime: ModelRuntime | undefined;
	let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
	let result: SimpleHarnessResult<string | TOutput> | undefined;
	let runDiagnostics: CandyRunDiagnostics | undefined;
	let runError: unknown;
	const cleanupErrors: unknown[] = [];
	const restoreEnvironment = applyIsolatedEnvironment(isolatedHome, agentDir);
	try {
		const authPath = join(hostAgentDir, "auth.json");
		const credentials = new InMemoryCredentialStore();
		const storedCredential = await new ReadOnlyAuthStorage(authPath).read(selection.provider, { signal });
		if (storedCredential) await credentials.modify(selection.provider, async () => storedCredential);
		modelRuntime = await ModelRuntime.create({ credentials });
		await Promise.all([mkdir(workspace), mkdir(agentDir, { recursive: true })]);
		await seedWorkspace(workspace, options.workspaceFiles);
		const model = modelRuntime.getModel(selection.provider, selection.id);
		if (!model) throw new Error(`Eval model not found: ${selection.provider}/${selection.id}`);
		const auth = await modelRuntime.getAuth(model);
		if (!auth) {
			throw new Error(`Eval model has no configured authentication: ${selection.provider}/${selection.id}`);
		}
		if (!storedCredential && auth.auth.apiKey) {
			await modelRuntime.setRuntimeApiKey(selection.provider, auth.auth.apiKey);
		}
		signal?.throwIfAborted();
		sessionManager = SessionHistory.create(workspace, join(root, "sessions"));
		setArtifact("runId", sessionManager.getSessionId());
		runtime = await createAgentSessionRuntime({
			cwd: workspace,
			agentDir,
			modelRuntime,
			sessionManager,
			model,
			thinkingLevel: "off",
			tools: options.tools,
			noTools: options.noTools,
			customTools: options.customTools,
			signal,
		});
		session = runtime.session;

		const unexpectedExtensions = runtime.resources
			.getInventory()
			.extensions.extensions.map((extension) => extension.path);
		if (unexpectedExtensions.length > 0) {
			throw new Error(`Isolated eval loaded unexpected extensions: ${unexpectedExtensions.join(", ")}`);
		}

		let response: string | undefined;
		const steps = typeof input === "string" ? [{ type: "prompt" as const, content: input }] : input;
		let abortPromise: Promise<void> | undefined;
		const abort = () => {
			abortPromise ??= session!.execution.abort();
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			for (const step of steps) {
				if (step.type === "reload") {
					await session.resources.reload();
					continue;
				}
				response = await promptAgent(session, step.content, signal);
			}
		} finally {
			signal?.removeEventListener("abort", abort);
			if (abortPromise) await abortPromise;
		}
		if (response === undefined) {
			throw new Error("candy eval input must include at least one prompt step.");
		}
		const committedMessages = getCommittedMessages(session);
		const systemPrompt = getCurrentSystemPrompt(committedMessages);
		const stats = session.history.getSessionStats();
		const hasPricing = [model.cost, ...(model.cost.tiers ?? [])].some(
			({ input: inputCost, output: outputCost, cacheRead, cacheWrite }) =>
				inputCost > 0 || outputCost > 0 || cacheRead > 0 || cacheWrite > 0,
		);
		runDiagnostics = {
			events: toTranscriptEvents(committedMessages),
			usage: {
				provider: model.provider,
				model: model.id,
				inputTokens: stats.tokens.input,
				outputTokens: stats.tokens.output,
				totalTokens: stats.tokens.total,
				toolCalls: stats.toolCalls,
				metadata: {
					cacheReadTokens: stats.tokens.cacheRead,
					cacheWriteTokens: stats.tokens.cacheWrite,
					...(hasPricing ? { estimatedCostUsd: stats.cost } : {}),
				},
			},
		};
		const output =
			"output" in options ? await options.output({ response, session, systemPrompt, agentDir }) : response;
		result = { output, ...runDiagnostics };
	} catch (error) {
		runError = error;
	} finally {
		if (sessionManager) {
			const sessionPath = sessionManager.getSessionFile();
			if (!sessionPath || !existsSync(sessionPath)) {
				cleanupErrors.push(new Error("candy eval produced no session file."));
			} else {
				try {
					setArtifact(CANDY_SESSION_SNAPSHOT_ARTIFACT, await readFile(sessionPath, "utf8"));
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
		}
		try {
			await runtime?.dispose();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			await modelRuntime?.dispose();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			await rm(root, { recursive: true, force: true });
		} catch (error) {
			cleanupErrors.push(error);
		}
		restoreEnvironment();
	}

	let failure = runError;
	if (runError !== undefined && cleanupErrors.length > 0) {
		failure = new AggregateError([runError, ...cleanupErrors], "Agent run failed and cleanup also failed.");
	} else if (cleanupErrors.length === 1) {
		failure = cleanupErrors[0];
	} else if (cleanupErrors.length > 1) {
		failure = new AggregateError(cleanupErrors, "Agent cleanup failed.");
	}
	if (failure !== undefined) {
		if (runDiagnostics) {
			const partialRun = normalizeHarnessRun(input, {
				...runDiagnostics,
				errors: [failure],
				timings: { totalMs: performance.now() - startedAt },
			});
			throw attachHarnessRunToError(failure, partialRun);
		}
		throw failure;
	}
	if (!result) throw new Error("candy eval completed without a result.");
	return { ...result, timings: { totalMs: performance.now() - startedAt } };
}

export function createCandyCodingAgentHarness<TOutput extends JsonValue>(
	options: CandyCodingAgentHarnessWithOutput<TOutput>,
): Harness<CandyCodingAgentInput, TOutput>;
export function createCandyCodingAgentHarness(
	options?: CandyCodingAgentHarnessOptions,
): Harness<CandyCodingAgentInput, string>;
export function createCandyCodingAgentHarness<TOutput extends JsonValue>(
	options: CandyCodingAgentHarnessOptions | CandyCodingAgentHarnessWithOutput<TOutput> = {},
): Harness<CandyCodingAgentInput, string | TOutput> {
	return createHarness<CandyCodingAgentInput, string | TOutput>({
		name: options.name ?? "coding-agent",
		run: ({ input, signal, setArtifact }) => runCandyCodingAgent(input, signal, setArtifact, options),
	});
}
