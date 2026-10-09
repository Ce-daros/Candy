import type * as fs from "node:fs";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonFileStorage } from "../src/core/storage/json-file.ts";

const creationRace = vi.hoisted(() => ({
	path: "",
	checks: 0,
	writeCompetingValue: undefined as (() => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof fs>();
	return {
		...original,
		existsSync(path: fs.PathLike) {
			const exists = original.existsSync(path);
			if (path === creationRace.path && !exists && !original.existsSync(`${path}.lock`)) {
				if (++creationRace.checks === 2) creationRace.writeCompetingValue?.();
			}
			return exists;
		},
	};
});

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
		creationRace.path = "";
		creationRace.writeCompetingValue = undefined;
		rmSync(directory, { recursive: true });
	});

	it("initializes under the lock without overwriting a competing writer", async () => {
		storage = new JsonFileStorage(path, { ensureFile: true });
		creationRace.path = path;
		creationRace.checks = 0;
		creationRace.writeCompetingValue = () => {
			new JsonFileStorage(path, { ensureFile: true }).withLock(() => ({ result: undefined, next: '{"other":1}' }));
		};
		const update = (current: string | undefined) => {
			expect(existsSync(`${path}.lock`)).toBe(true);
			return { result: undefined, next: JSON.stringify({ ...JSON.parse(current ?? "{}"), own: 2 }) };
		};
		if (api === "sync") storage.withLock(update);
		else await storage.withLockAsync(update);
		expect(creationRace.checks).toBe(0);
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ own: 2 });
	});

	it("keeps both updates from concurrent first writers", async () => {
		storage = new JsonFileStorage(path, { ensureFile: true });
		await Promise.all(
			["first", "second"].map((key) =>
				storage.withLockAsync(async (current) => {
					await Promise.resolve();
					return { result: undefined, next: JSON.stringify({ ...JSON.parse(current ?? "{}"), [key]: true }) };
				}),
			),
		);
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ first: true, second: true });
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
