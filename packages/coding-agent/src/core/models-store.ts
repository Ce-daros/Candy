import { join } from "node:path";
import type { ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "@candy/ai";
import { getAgentDir } from "../config.ts";
import { getFileRevision, normalizePath } from "../utils/paths.ts";
import { FileReadCache } from "./storage/file-read-cache.ts";
import { type JsonFileOptions, parseJsonFile, withLockedJsonFileAsync } from "./storage/json-file.ts";

type StoredModels = Record<string, ModelsStoreEntry>;

// POSIX files start with owner-only permissions and retain their existing mode on updates.
const MODELS_FILE_OPTIONS: JsonFileOptions = { mode: 0o600, dirMode: 0o700, ensureFile: true };

// Optimize the common path without retaining an unbounded set of custom paths.
let sharedModelsFileReadState: { path: string; readState: FileReadCache<StoredModels> } | undefined;

/** Locked JSON-backed storage for dynamically refreshed provider catalogs. */
export class FileModelsStore implements ModelsStore {
	private readonly path: string;
	private readonly readState: FileReadCache<StoredModels>;

	constructor(path: string = join(getAgentDir(), "models-store.json")) {
		this.path = normalizePath(path);
		this.readState =
			sharedModelsFileReadState?.path === this.path
				? sharedModelsFileReadState.readState
				: new FileReadCache<StoredModels>({});
		if (!sharedModelsFileReadState) {
			sharedModelsFileReadState = { path: this.path, readState: this.readState };
		}
	}

	private parse(content: string | undefined): StoredModels {
		return parseJsonFile(content, this.path, () => ({}));
	}

	private reloadFromStorage(options?: ModelsStoreOperationOptions): Promise<StoredModels> {
		return withLockedJsonFileAsync(
			this.path,
			(content) => {
				const data = this.parse(content);
				this.readState.update(data, getFileRevision(this.path));
				return { result: data };
			},
			{ ...MODELS_FILE_OPTIONS, signal: options?.signal },
		);
	}

	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		options?.signal?.throwIfAborted();
		const data = await this.readState.read(
			getFileRevision(this.path),
			(signal) => this.reloadFromStorage({ signal }),
			options?.signal,
		);
		const entry = data[providerId];
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
		if (latest) this.readState.update(latest);
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
		if (latest) this.readState.update(latest);
	}
}
