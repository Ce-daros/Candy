import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { checkArchitecture, findRuntimeCycles, normalizeWorkspacePath } from "./check-architecture-boundaries.mjs";

test("normalizes Windows and POSIX workspace separators identically", () => {
	assert.equal(normalizeWorkspacePath("packages\\agent\\src\\index.ts"), "packages/agent/src/index.ts");
	assert.equal(normalizeWorkspacePath("packages/agent/src/index.ts"), "packages/agent/src/index.ts");
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

	assert.equal(checkArchitecture(graph).filter((failure) => failure.includes("imports presentation module")).length, 4);
});
