import { constants, copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { basename, join, parse, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { CreateAgentSessionResult } from "./agent-session-factory.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { SessionManager } from "./session-manager.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when a session import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;
	private replacementQueue: Promise<void> = Promise.resolve();
	private disposePromise?: Promise<void>;
	private disposed = false;
	private readonly sessionListeners = new Set<(session: AgentSession) => Promise<void>>();

	subscribeSession(listener: (session: AgentSession) => Promise<void>): () => void {
		this.sessionListeners.add(listener);
		return () => this.sessionListeners.delete(listener);
	}

	private enqueueReplacement<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.replacementQueue.then(() => {
			if (this.disposed) throw new Error("Session runtime is disposed");
			return operation();
		});
		this.replacementQueue = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		// Settle any active response first so the aborted turn (including tool
		// results) is persisted to the outgoing session before it is replaced.
		const errors: unknown[] = [];
		try {
			await this.session.abort();
		} catch (error) {
			errors.push(error);
		}
		try {
			await emitSessionShutdownEvent(this.session.extensionRunner, {
				type: "session_shutdown",
				reason,
				targetSessionFile,
			});
		} catch (error) {
			errors.push(error);
		}
		try {
			this.beforeSessionInvalidate?.();
		} catch (error) {
			errors.push(error);
		}
		try {
			await this.session.dispose();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length) throw new AggregateError(errors, "Outgoing session cleanup failed");
	}

	private async discardCandidate(
		error: unknown,
		candidate?: AgentSession,
		candidateServices?: AgentSessionServices,
		ownedFile?: string,
	): Promise<never> {
		const errors = [error];
		if (candidate) {
			try {
				await candidate.dispose();
			} catch (disposeError) {
				errors.push(disposeError);
			}
		}
		if (candidateServices) {
			try {
				await candidateServices.dispose();
			} catch (disposeError) {
				errors.push(disposeError);
			}
		}
		if (ownedFile && existsSync(ownedFile)) {
			try {
				unlinkSync(ownedFile);
			} catch (fileError) {
				errors.push(fileError);
			}
		}
		if (errors.length > 1) throw new AggregateError(errors, "Session preparation and candidate cleanup failed");
		throw error;
	}

	private apply(result: CreateAgentSessionRuntimeResult): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		for (const listener of this.sessionListeners) await listener(this.session);
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	private async replaceSession(
		create: () => Promise<CreateAgentSessionRuntimeResult>,
		reason: SessionShutdownEvent["reason"],
		targetSessionFile: string | undefined,
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>,
		ownedFile?: string,
	): Promise<void> {
		let replacement: CreateAgentSessionRuntimeResult;
		try {
			replacement = await create();
		} catch (error) {
			return this.discardCandidate(error, undefined, undefined, ownedFile);
		}
		const outgoingServices = this.services;
		try {
			await this.teardownCurrent(reason, targetSessionFile);
		} catch (error) {
			return this.discardCandidate(error, replacement.session, replacement.services, ownedFile);
		}
		this.apply(replacement);
		const errors: unknown[] = [];
		try {
			await outgoingServices.dispose();
		} catch (error) {
			errors.push(error);
		}
		try {
			await this.finishSessionReplacement(withSession);
		} catch (error) {
			errors.push(error);
		}
		if (errors.length) throw new AggregateError(errors, "Session replacement cleanup failed");
	}

	switchSession(...args: Parameters<AgentSessionRuntime["switchSessionOperation"]>) {
		return this.enqueueReplacement(() => this.switchSessionOperation(...args));
	}

	private async switchSessionOperation(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.replaceSession(
			() =>
				this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
					projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
				}),
			"resume",
			sessionManager.getSessionFile(),
			options?.withSession,
		);
		return { cancelled: false };
	}

	newSession(...args: Parameters<AgentSessionRuntime["newSessionOperation"]>) {
		return this.enqueueReplacement(() => this.newSessionOperation(...args));
	}

	private async newSessionOperation(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.session.sessionManager.getSessionDir();
		const sessionManager = this.session.sessionManager.isPersisted()
			? SessionManager.create(this.cwd, sessionDir)
			: SessionManager.inMemory(this.cwd);
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		const replacement = await this.createRuntime({
			cwd: this.cwd,
			agentDir: this.services.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
		});
		try {
			if (options?.setup) {
				await options.setup(replacement.session.sessionManager);
				replacement.session.refreshContext();
			}
		} catch (error) {
			return this.discardCandidate(
				error,
				replacement.session,
				replacement.services,
				sessionManager.getSessionFile(),
			);
		}

		await this.replaceSession(
			() => Promise.resolve(replacement),
			"new",
			sessionManager.getSessionFile(),
			options?.withSession,
			sessionManager.getSessionFile(),
		);
		return { cancelled: false };
	}

	fork(...args: Parameters<AgentSessionRuntime["forkOperation"]>) {
		return this.enqueueReplacement(() => this.forkOperation(...args));
	}

	clone(options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> }): Promise<{ cancelled: boolean }> {
		return this.enqueueReplacement(async () => {
			const leafId = this.session.sessionManager.getLeafId();
			if (!leafId) throw new Error("Nothing to clone yet");
			const { cancelled } = await this.forkOperation(leafId, { position: "at", ...options });
			return { cancelled };
		});
	}

	private async forkOperation(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		if (this.session.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
				await this.replaceSession(
					() =>
						this.createRuntime({
							cwd: this.cwd,
							agentDir: this.services.agentDir,
							sessionManager,
							sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
						}),
					"fork",
					sessionManager.getSessionFile(),
					options?.withSession,
				);
				return { cancelled: false, selectedText };
			}

			if (!existsSync(currentSessionFile)) {
				throw new Error("This session has not been saved yet. Send a message before cloning or forking it.");
			}
			const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			await this.replaceSession(
				() =>
					this.createRuntime({
						cwd: sessionManager.getCwd(),
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
				"fork",
				sessionManager.getSessionFile(),
				options?.withSession,
				forkedSessionPath,
			);
			return { cancelled: false, selectedText };
		}

		const sessionManager = SessionManager.inMemory(this.cwd, undefined, this.session.sessionManager.getEntries());
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		await this.replaceSession(
			() =>
				this.createRuntime({
					cwd: this.cwd,
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
			"fork",
			sessionManager.getSessionFile(),
			options?.withSession,
		);
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		return this.enqueueReplacement(() => this.importOperation(inputPath, cwdOverride));
	}

	private async importOperation(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this.session.sessionManager.getSessionDir();
		const source = SessionManager.open(resolvedPath, sessionDir, cwdOverride);
		assertSessionCwdExists(source, this.cwd);
		source.buildSessionContext();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		let destinationPath = join(sessionDir, basename(resolvedPath));
		const sourceAlreadyStored = resolve(destinationPath) === resolvedPath;
		if (!sourceAlreadyStored) {
			const { name, ext } = parse(destinationPath);
			let suffix = 1;
			while (existsSync(destinationPath)) {
				destinationPath = join(sessionDir, `${name}-${suffix++}${ext}`);
			}
		}
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		if (!sourceAlreadyStored) {
			copyFileSync(resolvedPath, destinationPath, constants.COPYFILE_EXCL);
		}

		try {
			const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
			await this.replaceSession(
				() =>
					this.createRuntime({
						cwd: sessionManager.getCwd(),
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
					}),
				"resume",
				sessionManager.getSessionFile(),
			);
		} catch (error) {
			if (!sourceAlreadyStored && this.session.sessionFile !== destinationPath) {
				return this.discardCandidate(error, undefined, undefined, destinationPath);
			}
			throw error;
		}
		return { cancelled: false };
	}

	dispose(): Promise<void> {
		this.disposePromise ??= this.enqueueReplacement(async () => {
			this.disposed = true;
			const errors: unknown[] = [];
			try {
				await this.session.abort();
			} catch (error) {
				errors.push(error);
			}
			try {
				await emitSessionShutdownEvent(this.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			} catch (error) {
				errors.push(error);
			}
			try {
				this.beforeSessionInvalidate?.();
			} catch (error) {
				errors.push(error);
			}
			try {
				await this.session.dispose();
			} catch (error) {
				errors.push(error);
			}
			try {
				await this.services.dispose();
			} catch (error) {
				errors.push(error);
			}
			this.sessionListeners.clear();
			if (errors.length) throw new AggregateError(errors, "Session runtime disposal failed");
		});
		return this.disposePromise;
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later new-session, resume, fork, and import flows.
 */
export async function createRuntimeFromFactory(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	assembleAgentSessionFromServices,
	assembleAgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
} from "./agent-session-services.ts";
