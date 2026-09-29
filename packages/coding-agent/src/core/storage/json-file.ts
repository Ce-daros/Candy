/**
 * One owner for lock-protected JSON files.
 *
 * Stores keep their own schema, validation, and merge rules; they do not restate
 * locking, retry, read, or write policy. The async API retries with exponential
 * backoff and an abort signal. The sync API retries without spinning the CPU,
 * for callers that cannot await (settings and project trust).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { stripBom } from "../../utils/text.ts";

/** A locked-file transaction: the value to return, plus replacement content when the file changes. */
export interface LockedJsonUpdate<T> {
	result: T;
	next?: string;
}

export interface JsonFileOptions {
	/** File mode applied only when the file is created. */
	mode?: number;
	/** Directory mode applied only when the parent directory is created. */
	dirMode?: number;
	/** Create an empty `{}` file when missing, so other processes always find valid JSON. */
	ensureFile?: boolean;
	/** Lock artifact path. Defaults to proper-lockfile's `<path>.lock`. */
	lockfilePath?: string;
	/** Abort signal for the async API. */
	signal?: AbortSignal;
	/** Called when the async lock is compromised, i.e. taken over as stale. */
	onCompromised?: (error: Error) => void;
}

export class JsonFileParseError extends Error {
	readonly path: string;

	constructor(path: string, cause: unknown) {
		super(`Invalid JSON in ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
		this.name = "JsonFileParseError";
		this.path = path;
	}
}

/** Parse JSON content, using `fallback` when the file is absent or empty. */
export function parseJsonFile<T>(content: string | undefined, path: string, fallback: () => T): T {
	if (!content) return fallback();
	try {
		return JSON.parse(stripBom(content)) as T;
	} catch (error) {
		throw new JsonFileParseError(path, error);
	}
}

const MAX_ATTEMPTS = 10;
const BASE_DELAY_MS = 10;
const MAX_DELAY_MS = 2_000;
const STALE_MS = 30_000;

function isLockedError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		String((error as { code?: unknown }).code) === "ELOCKED"
	);
}

/** Synchronous wait that yields the CPU instead of spinning it. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureParentDir(path: string, options: JsonFileOptions): void {
	const directory = dirname(path);
	if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: options.dirMode });
}

function ensureFile(path: string, options: JsonFileOptions): void {
	if (!options.ensureFile || existsSync(path)) return;
	ensureParentDir(path, options);
	writeFileSync(path, "{}", { encoding: "utf-8", mode: options.mode });
}

function writeAtomically(path: string, content: string, mode?: number): void {
	const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporaryPath, content, { encoding: "utf-8", mode });
		renameSync(temporaryPath, path);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

function acquireLockSync(path: string, options: JsonFileOptions): () => void {
	for (let attempt = 0; ; attempt++) {
		try {
			return lockfile.lockSync(path, { realpath: false, lockfilePath: options.lockfilePath });
		} catch (error) {
			if (!isLockedError(error) || attempt >= MAX_ATTEMPTS - 1) throw error;
			sleepSync(Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS));
		}
	}
}

async function acquireLockAsync(
	path: string,
	options: JsonFileOptions,
	onCompromised: (error: Error) => void,
): Promise<() => Promise<void>> {
	const deadline = Date.now() + STALE_MS;
	for (let retry = 0; ; retry++) {
		options.signal?.throwIfAborted();
		try {
			return await lockfile.lock(path, {
				realpath: false,
				lockfilePath: options.lockfilePath,
				retries: 0,
				stale: STALE_MS,
				onCompromised,
			});
		} catch (error) {
			options.signal?.throwIfAborted();
			const remainingMs = deadline - Date.now();
			if (!isLockedError(error) || remainingMs <= 0) throw error;
			const baseDelayMs = Math.min(BASE_DELAY_MS * 2 ** retry, MAX_DELAY_MS / 2);
			const delayMs = Math.min(Math.round(baseDelayMs * (1 + Math.random())), remainingMs);
			if (options.signal) await delay(delayMs, undefined, { signal: options.signal });
			else await delay(delayMs);
		}
	}
}

/**
 * Read and update a JSON file under its lock. The lock is taken when the file
 * exists, and additionally before creating it. The parent directory is created
 * only when content is written, so a read never leaves an empty directory behind.
 */
export function withLockedJsonFileSync<T>(
	path: string,
	update: (current: string | undefined) => LockedJsonUpdate<T>,
	options: JsonFileOptions = {},
): T {
	let release: (() => void) | undefined;
	try {
		if (options.ensureFile && !existsSync(path)) {
			ensureParentDir(path, options);
			ensureFile(path, options);
		}
		if (existsSync(path)) {
			release = acquireLockSync(path, options);
			const { result, next } = update(readFileSync(path, "utf-8"));
			if (next !== undefined) writeAtomically(path, next, options.mode);
			return result;
		}

		// A missing file cannot be locked until its parent exists. Evaluate once to
		// avoid creating directories for read-only calls; if it writes, acquire the
		// lock and evaluate again against the latest content before committing.
		const initial = update(undefined);
		if (initial.next === undefined) return initial.result;
		ensureParentDir(path, options);
		release = acquireLockSync(path, options);
		const current = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
		const committed = update(current);
		if (committed.next !== undefined) writeAtomically(path, committed.next, options.mode);
		return committed.result;
	} finally {
		release?.();
	}
}

/** Async variant of {@link withLockedJsonFileSync}. Backs off instead of spinning. */
export async function withLockedJsonFileAsync<T>(
	path: string,
	update: (current: string | undefined) => LockedJsonUpdate<T> | Promise<LockedJsonUpdate<T>>,
	options: JsonFileOptions = {},
): Promise<T> {
	options.signal?.throwIfAborted();
	ensureParentDir(path, options);
	ensureFile(path, options);

	let compromisedError: Error | undefined;
	let release: (() => Promise<void>) | undefined;
	const throwIfCompromised = () => {
		if (compromisedError) throw compromisedError;
	};

	try {
		release = await acquireLockAsync(path, options, (error) => {
			compromisedError = error;
			options.onCompromised?.(error);
		});
		throwIfCompromised();
		options.signal?.throwIfAborted();

		const current = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
		const { result, next } = await update(current);
		throwIfCompromised();
		options.signal?.throwIfAborted();

		if (next !== undefined) writeAtomically(path, next, options.mode);
		throwIfCompromised();
		return result;
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				// A compromised lock already surfaced through throwIfCompromised.
			}
		}
	}
}

/** File backend for stores that keep their own content schema and merge rules. */
export class JsonFileStorage {
	readonly path: string;
	private readonly options: JsonFileOptions;

	constructor(path: string, options: JsonFileOptions = {}) {
		this.path = path;
		this.options = options;
	}

	withLock<T>(update: (current: string | undefined) => LockedJsonUpdate<T>): T {
		return withLockedJsonFileSync(this.path, update, this.options);
	}

	withLockAsync<T>(
		update: (current: string | undefined) => LockedJsonUpdate<T> | Promise<LockedJsonUpdate<T>>,
		options: JsonFileOptions = {},
	): Promise<T> {
		return withLockedJsonFileAsync(this.path, update, { ...this.options, ...options });
	}
}
