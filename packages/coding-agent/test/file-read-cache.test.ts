import { describe, expect, it, vi } from "vitest";
import { FileReadCache } from "../src/core/storage/file-read-cache.ts";

describe("FileReadCache", () => {
	it("reuses only a known matching revision and checks cancellation first", async () => {
		const cache = new FileReadCache("stored");
		cache.update("stored", "revision");
		const load = vi.fn(async () => "loaded");
		await expect(cache.read("revision", load)).resolves.toBe("stored");
		expect(load).not.toHaveBeenCalled();

		const controller = new AbortController();
		controller.abort();
		await expect(cache.read("revision", load, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(load).not.toHaveBeenCalled();

		cache.update("stored");
		await expect(cache.read(undefined, load)).resolves.toBe("loaded");
		await expect(cache.read(undefined, load)).resolves.toBe("loaded");
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("keeps the shared reload active until the last reader cancels", async () => {
		const cache = new FileReadCache("stored");
		const load = vi.fn((_signal: AbortSignal) => new Promise<string>(() => {}));
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = cache.read("changed", load, firstController.signal);
		const second = cache.read("changed", load, secondController.signal);
		const signal = load.mock.calls[0][0];

		firstController.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		expect(signal.aborted).toBe(false);
		secondController.abort();
		await expect(second).rejects.toMatchObject({ name: "AbortError" });
		expect(signal.aborted).toBe(true);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("does not let a cancelled reload clear its replacement when it finishes later", async () => {
		const cache = new FileReadCache("stored");
		let finishOld!: (value: string) => void;
		const oldWork = new Promise<string>((resolve) => {
			finishOld = resolve;
		});
		let finishNew!: (value: string) => void;
		const newWork = new Promise<string>((resolve) => {
			finishNew = resolve;
		});
		const load = vi
			.fn<(signal: AbortSignal) => Promise<string>>()
			.mockReturnValueOnce(oldWork)
			.mockReturnValue(newWork);
		const controller = new AbortController();
		const oldRead = cache.read("changed", load, controller.signal);
		controller.abort();
		await expect(oldRead).rejects.toMatchObject({ name: "AbortError" });

		const firstNewRead = cache.read("changed", load);
		finishOld("old");
		await oldWork;
		const secondNewRead = cache.read("changed", load);
		expect(load).toHaveBeenCalledTimes(2);
		finishNew("new");
		await expect(Promise.all([firstNewRead, secondNewRead])).resolves.toEqual(["new", "new"]);
	});

	it("propagates a reload error and allows a later read to retry", async () => {
		const cache = new FileReadCache("stored");
		cache.update("stored", "previous");
		const error = new Error("read failed");
		const load = vi
			.fn<(signal: AbortSignal) => Promise<string>>()
			.mockRejectedValueOnce(error)
			.mockResolvedValueOnce("loaded");
		await expect(cache.read("changed", load)).rejects.toBe(error);
		expect(cache.data).toBe("stored");
		expect(cache.revision).toBe("previous");
		await expect(cache.read("changed", load)).resolves.toBe("loaded");
		expect(load).toHaveBeenCalledTimes(2);
	});
});
