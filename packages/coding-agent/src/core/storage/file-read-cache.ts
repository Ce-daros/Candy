import { raceWithAbortSignal } from "@candy/ai/utils/abort";

/** Shares one revision-based file reload until every reader has finished or cancelled. */
export class FileReadCache<T> {
	data: T;
	revision?: string;
	private pending?: { controller: AbortController; promise: Promise<T>; readers: number };

	constructor(data: T) {
		this.data = data;
	}

	update(data: T, revision?: string): void {
		this.data = data;
		this.revision = revision;
	}

	async read(
		revision: string | undefined,
		load: (signal: AbortSignal) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		signal?.throwIfAborted();
		if (revision !== undefined && revision === this.revision) return this.data;
		if (!this.pending) {
			const controller = new AbortController();
			const pending = { controller, promise: load(controller.signal), readers: 0 };
			this.pending = pending;
			const clear = () => {
				if (this.pending === pending) this.pending = undefined;
			};
			void pending.promise.then(clear, clear);
		}

		const pending = this.pending;
		pending.readers++;
		try {
			return await raceWithAbortSignal(pending.promise, signal);
		} finally {
			pending.readers--;
			if (pending.readers === 0 && this.pending === pending) {
				this.pending = undefined;
				pending.controller.abort();
			}
		}
	}
}
