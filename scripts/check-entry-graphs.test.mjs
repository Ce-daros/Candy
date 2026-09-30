import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkEntryGraphFailures, findUnreachableSources } from "./check-entry-graphs.mjs";
import { createWorkspaceResolver } from "./lib/source-graphs.mjs";

test("package export boundaries, dynamic roots, and packaged assets resolve", () => {
	assert.deepEqual(checkEntryGraphFailures(), []);
});

test("reachability retains type contracts and workers while identifying unused implementations", () => {
	const directory = mkdtempSync(resolve(tmpdir(), "candy-entry-graph-"));
	try {
		const entry = resolve(directory, "entry.ts");
		const contract = resolve(directory, "contract.ts");
		const worker = resolve(directory, "worker.ts");
		const unused = resolve(directory, "unused.ts");
		writeFileSync(entry, 'import type { Contract } from "./contract.ts";\nexport const worker = new URL("./worker.ts", import.meta.url);\n');
		writeFileSync(contract, "export interface Contract { value: string }\n");
		writeFileSync(worker, "export const ready = true;\n");
		writeFileSync(unused, "export const unused = true;\n");
		assert.deepEqual(findUnreachableSources([entry, contract, worker, unused], [entry], createWorkspaceResolver()), [unused]);
	} finally {
		rmSync(directory, { recursive: true });
	}
});
