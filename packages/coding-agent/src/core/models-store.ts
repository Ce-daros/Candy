import { join } from "node:path";
import type { ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "@candy/ai";
import { raceWithAbortSignal } from "@candy/ai/utils/abort";
import { getAgentDir } from "../config.ts";
import { getFileRevision, normalizePath } from "../utils/paths.ts";
import { type JsonFileOptions, parseJsonFile, withLockedJsonFileAsync } from "./storage/json-file.ts";

type StoredModels = Record<string, ModelsStoreEntry>;

type ModelsFileReload = {
	controller: AbortController;
	promise: Promise<StoredModels>;
	readers: number;
};

type ModelsFileReadState = {
	data: StoredModels;
	revision?: string;
	reload?: ModelsFileReload;
};

// The mode applies only on creation so administrator-managed modes and ACLs remain intact.
const MODELS_FILE_OPTIONS: JsonFileOptions = { mode: 0o600, dirMode: 0o700, ensureFile: true };

// Optimize the common path without retaining an unbounded set of custom paths.
let sharedModelsFileReadState: { path: string; readState: ModelsFileReadState } | undefined;

/** Locked JSON-backed storage for dynamically refreshed provider catalogs. */
export class FileModelsStore implements ModelsStore {
	private readonly path: string;
	private readonly readState: ModelsFileReadState;

	constructor(path: string = join(getAgentDir(), "models-store.json")) {
		this.path = normalizePath(path);
		this.readState =
			sharedModelsFileReadState?.path === this.path ? sharedModelsFileReadState.readState : { data: {} };
		if (!sharedModelsFileReadState) {
			sharedModelsFileReadState = { path: this.path, readState: this.readState };
		}
	}

	private parse(content: string | undefined): StoredModels {
		return parseJsonFile(content, this.path, () => ({}));
	}

	private updateReadState(readState: ModelsFileReadState, data: StoredModels, revision?: string): void {
		readState.data = data;
		readState.revision = revision;
	}

	private reloadFromStorage(
		readState: ModelsFileReadState,
		options?: ModelsStoreOperationOptions,
	): Promise<StoredModels> {
		return withLockedJsonFileAsync(
			this.path,
			(content) => {
				const data = this.parse(content);
				this.updateReadState(readState, data, getFileRevision(this.path));
				return { result: data };
			},
			{ ...MODELS_FILE_OPTIONS, signal: options?.signal },
		);
	}

	private async readLatest(
		readState: ModelsFileReadState,
		options?: ModelsStoreOperationOptions,
	): Promise<StoredModels> {
		options?.signal?.throwIfAborted();
		const revision = getFileRevision(this.path);
		if (revision !== undefined && revision === readState.revision) return readState.data;
		if (!readState.reload) {
			const controller = new AbortController();
			const reload: ModelsFileReload = {
				controller,
				promise: this.reloadFromStorage(readState, { signal: controller.signal }),
				readers: 0,
			};
			readState.reload = reload;
			void reload.promise.then(
				() => {
					if (readState.reload === reload) readState.reload = undefined;
				},
				() => {
					if (readState.reload === reload) readState.reload = undefined;
				},
			);
		}

		const reload = readState.reload;
		reload.readers++;
		try {
			return await raceWithAbortSignal(reload.promise, options?.signal);
		} finally {
			reload.readers--;
			if (reload.readers === 0 && readState.reload === reload) {
				readState.reload = undefined;
				reload.controller.abort();
			}
		}
	}

	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		const entry = (await this.readLatest(this.readState, options))[providerId];
		options?.signal?.throwIfAborted();
		return entry ? structuredClone(entry) : undefined;
	}

	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		let latest: StoredModels | undefined;
		await withLockedJsonFileAsync(
			this.path,
			(content) => {
				const current = this.parse(content);
				current[providerId] = structuredClone(entry);
				latest = current;
				return { result: undefined, next: JSON.stringify(current, null, 2) };
			},
			{ ...MODELS_FILE_OPTIONS, signal: options?.signal },
		);
		if (latest) this.updateReadState(this.readState, latest);
	}

	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		let latest: StoredModels | undefined;
		await withLockedJsonFileAsync(
			this.path,
			(content) => {
				const current = this.parse(content);
				delete current[providerId];
				latest = current;
				return { result: undefined, next: JSON.stringify(current, null, 2) };
			},
			{ ...MODELS_FILE_OPTIONS, signal: options?.signal },
		);
		if (latest) this.updateReadState(this.readState, latest);
	}
}
