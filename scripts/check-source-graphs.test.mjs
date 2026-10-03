import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import test from "node:test";
import {
	checkArchitecture,
	checkExportGraphBudget,
	findRuntimeCycles,
	findUnreachableSources,
} from "./check-source-graphs.mjs";
import { buildValueGraph, createSourceScanner, createWorkspaceResolver, normalizePath } from "./lib/source-graphs.mjs";

test("reachability retains type contracts and workers while identifying unused implementations", () => {
	const directory = mkdtempSync(resolve(tmpdir(), "candy-entry-graph-"));
	try {
		const entry = resolve(directory, "entry.ts");
		const contract = resolve(directory, "contract.ts");
		const worker = resolve(directory, "worker.ts");
		const unused = resolve(directory, "unused.ts");
		writeFileSync(
			entry,
			'import type { Contract } from "./contract.ts";\nexport const worker = new URL("./worker.ts", import.meta.url);\n',
		);
		writeFileSync(contract, "export interface Contract { value: string }\n");
		writeFileSync(worker, "export const ready = true;\n");
		writeFileSync(unused, "export const unused = true;\n");
		assert.deepEqual(findUnreachableSources([entry, contract, worker, unused], [entry], createWorkspaceResolver()), [
			unused,
		]);
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test("normalizes Windows and POSIX workspace separators identically", () => {
	assert.equal(normalizePath("packages\\agent\\src\\index.ts"), "packages/agent/src/index.ts");
	assert.equal(normalizePath("packages/agent/src/index.ts"), "packages/agent/src/index.ts");
});

test("finds runtime strongly connected components and self-cycles", () => {
	const graph = new Map([
		["a.ts", new Set(["b.ts"])],
		["b.ts", new Set(["a.ts", "c.ts"])],
		["c.ts", new Set()],
		["self.ts", new Set(["self.ts"])],
	]);

	assert.deepEqual(findRuntimeCycles(graph), [["a.ts", "b.ts"], ["self.ts"]]);
});

test("enforces one-way runtime dependencies between agent, terminal UI, and CLI", () => {
	const agentEntry = resolve("packages/agent/src/index.ts");
	const terminalEntry = resolve("packages/tui/src/index.ts");
	const aiEntry = resolve("packages/ai/src/index.ts");
	const cliEntry = resolve("packages/coding-agent/src/main.ts");
	const graph = new Map([
		[agentEntry, new Set([terminalEntry])],
		[terminalEntry, new Set([cliEntry])],
		[aiEntry, new Set([terminalEntry])],
		[cliEntry, new Set()],
	]);

	const failures = checkArchitecture(graph).join("\n");
	assert.match(failures, /agent-core must not depend on @candy\/tui/);
	assert.match(failures, /@candy\/tui must not depend on @candy\/coding-agent/);
	assert.match(failures, /@candy\/ai must not depend on @candy\/tui/);
});

test("keeps terminal presentation and TUI out of the core runtime", () => {
	const runtime = resolve("packages/coding-agent/src/core/fake-runtime.ts");
	const interactiveMode = resolve("packages/coding-agent/src/modes/interactive/interactive-mode.ts");
	const theme = resolve("packages/coding-agent/src/modes/interactive/theme/theme.ts");
	const renderer = resolve("packages/coding-agent/src/presentation/tool-renderer.ts");
	const tui = resolve("packages/tui/src/index.ts");
	const graph = new Map([[runtime, new Set([interactiveMode, theme, renderer, tui])]]);

	assert.equal(
		checkArchitecture(graph, createWorkspaceResolver(), []).filter((failure) =>
			failure.includes("imports presentation module"),
		).length,
		4,
	);
});

test("checks type-only imports from core against presentation implementations", () => {
	const directory = mkdtempSync(resolve("packages/coding-agent/src/core", ".architecture-test-"));
	try {
		const source = resolve(directory, "type-boundary.ts");
		writeFileSync(
			source,
			`import type { KeybindingsConfig } from "../../presentation/keybindings.ts";\nimport { type ThemeColor } from "../../contracts/theme.ts";\n`,
		);
		const resolver = createWorkspaceResolver();
		const failures = checkArchitecture(new Map([[source, new Set()]]), resolver, [source]);
		assert.equal(failures.length, 1);
		assert.match(failures[0], /type dependency on presentation module/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("resolves public workspace package exports to their source modules", () => {
	const resolver = createWorkspaceResolver();
	assert.equal(
		relative(
			process.cwd(),
			resolver.resolveImport("@candy/coding-agent/ui", resolve("packages/ai/src/index.ts")),
		).replaceAll("\\", "/"),
		"packages/coding-agent/src/ui.ts",
	);
	assert.equal(
		relative(
			process.cwd(),
			resolver.resolveImport("@candy/ai/providers/all", resolve("packages/coding-agent/src/index.ts")),
		).replaceAll("\\", "/"),
		"packages/ai/src/providers/all.ts",
	);
});

test("reports export size budgets and forbidden dependencies with reachable paths", () => {
	const files = [
		"packages/ai/src/utils/tool.ts",
		"packages/ai/src/providers/all.ts",
		"packages/ai/src/api/catalog.ts",
		"packages/ai/src/index.ts",
	];
	const failures = checkExportGraphBudget("packages/ai", "./utils/tool", files, {
		maxFiles: 3,
		forbid: ["providers/", "api/", "index.ts"],
	});
	assert.equal(failures.length, 4);
	assert.match(failures[0], /reaches 4 files, budget 3/);
	assert.match(failures[1], /must not reach providers\/.*\n    packages\/ai\/src\/providers\/all.ts/);
	assert.deepEqual(
		checkExportGraphBudget("packages/ai", "./utils/tool", [files[0]], { maxFiles: 3, forbid: ["providers/"] }),
		[],
	);
});

test("shares value and type edges across graph roots and retains conditional worker URLs", (t) => {
	const directory = mkdtempSync(resolve(tmpdir(), "candy-source-graph-"));
	t.after(() => rmSync(directory, { recursive: true }));
	const entry = resolve(directory, "entry.ts");
	const contract = resolve(directory, "contract.ts");
	const worker = resolve(directory, "worker.ts");
	const runtime = resolve(directory, "runtime.ts");
	writeFileSync(
		entry,
		'export type { Contract } from "./contract.ts";\nexport { value } from "./runtime.ts";\nexport const worker = new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);\n',
	);
	writeFileSync(contract, "export interface Contract { value: string }\n");
	writeFileSync(worker, "export const ready = true;\n");
	writeFileSync(runtime, "export const value = true;\n");
	const resolver = createWorkspaceResolver();
	const scanner = createSourceScanner(resolver, [directory]);
	assert.deepEqual(new Set(buildValueGraph([entry], resolver, { scanner }).keys()), new Set([entry, runtime, worker]));
	writeFileSync(entry, 'import "./missing.ts";\n');
	assert.deepEqual(
		new Set(buildValueGraph([entry], resolver, { scanner, includeTypes: true }).keys()),
		new Set([entry, runtime, worker, contract]),
	);
	assert.equal(scanner.files.length, 4);
});

test("source inventory retains hidden files, nested TypeScript directories, and module extensions", (t) => {
	const directory = mkdtempSync(resolve(tmpdir(), "candy-source-scope-"));
	t.after(() => rmSync(directory, { recursive: true }));
	const paths = [
		"entry.ts",
		"module.mts",
		"module.cts",
		".hidden.ts",
		".tools/nested.ts",
		"directory.ts/child.ts",
		"types.d.ts",
	];
	for (const file of paths) {
		mkdirSync(resolve(directory, file, ".."), { recursive: true });
		writeFileSync(resolve(directory, file), "export {};\n");
	}
	const scanner = createSourceScanner(createWorkspaceResolver(), [directory]);
	assert.deepEqual(
		new Set(scanner.files),
		new Set(paths.filter((file) => !file.endsWith(".d.ts")).map((file) => resolve(directory, file))),
	);
});
