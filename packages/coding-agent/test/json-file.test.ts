import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonFileStorage } from "../src/core/storage/json-file.ts";

describe.each(["sync", "async"] as const)("JSON file %s writes", (api) => {
	let directory: string;
	let path: string;
	let storage: JsonFileStorage;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "candy-json-file-"));
		path = join(directory, "store.json");
		storage = new JsonFileStorage(path, { mode: 0o600 });
	});

	afterEach(() => {
		rmSync(directory, { recursive: true });
	});

	async function write(next: string): Promise<void> {
		const update = () => ({ result: undefined, next });
		if (api === "sync") storage.withLock(update);
		else await storage.withLockAsync(update);
	}

	it.skipIf(process.platform === "win32")(
		"preserves the latest existing mode despite a restrictive umask",
		async () => {
			writeFileSync(path, "{}");
			chmodSync(path, 0o660);
			const previousMask = process.umask(0o077);
			try {
				await write('{"value":1}');
				expect(statSync(path).mode & 0o777).toBe(0o660);

				chmodSync(path, 0o640);
				await write('{"value":2}');
				expect(statSync(path).mode & 0o777).toBe(0o640);
				expect(readFileSync(path, "utf-8")).toBe('{"value":2}');
				expect(readdirSync(directory)).toEqual(["store.json"]);
			} finally {
				process.umask(previousMask);
			}
		},
	);

	it.skipIf(process.platform === "win32")("uses the configured creation mode for a new file", async () => {
		await write('{"value":1}');
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf-8")).toBe('{"value":1}');
		expect(readdirSync(directory)).toEqual(["store.json"]);
	});
});
