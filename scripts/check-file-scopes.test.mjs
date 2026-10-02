import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function check(t, script, files) {
	const root = mkdtempSync(resolve(tmpdir(), "candy-check-scope-"));
	t.after(() => rmSync(root, { recursive: true }));
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(dirname(resolve(root, file)), { recursive: true });
		writeFileSync(resolve(root, file), content);
	}
	return spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
		cwd: root,
		encoding: "utf8",
	});
}

test("pinned dependencies include root, fixtures, examples, and hidden package manifests", (t) => {
	const unpinned = JSON.stringify({ dependencies: { dependency: "^1.2.3" } });
	const result = check(t, "./check-pinned-deps.mjs", {
		"package.json": unpinned,
		"packages/example/test/fixtures/with-deps/package.json": unpinned,
		"packages/example/examples/project/package.json": unpinned,
		".tools/package.json": unpinned,
		"scripts/package.json/package.json": unpinned,
	});
	assert.equal(result.status, 1, result.stderr);
	for (const path of [
		"package.json",
		"fixtures/with-deps/package.json",
		"examples/project/package.json",
		".tools/package.json",
		"scripts/package.json/package.json",
	]) {
		assert.ok(result.stderr.replaceAll("\\", "/").includes(path), result.stderr);
	}
});

test("pinned dependencies exclude git, build output, and dependency directories at any depth", (t) => {
	const unpinned = JSON.stringify({ dependencies: { dependency: "^1.2.3" } });
	const result = check(t, "./check-pinned-deps.mjs", {
		"package.json": JSON.stringify({
			dependencies: {
				dependency: "1.2.3",
				alias: "npm:@scope/dependency@1.2.3",
				"@candy/example": "^1.2.3",
				local: "file:./local",
			},
		}),
		".git/package.json": unpinned,
		"dist/package.json": unpinned,
		"node_modules/package.json": unpinned,
		"packages/example/.git/package.json": unpinned,
		"packages/example/dist/package.json": unpinned,
		"packages/example/node_modules/package.json": unpinned,
	});
	assert.equal(result.status, 0, result.stderr);
});

test("TypeScript import checks include root, scripts, fixtures, hidden paths, and generated sources", (t) => {
	const invalid = 'import "./missing.js";\n';
	const result = check(t, "./check-ts-relative-imports.mjs", {
		"root.ts": invalid,
		"scripts/task.ts": invalid,
		"packages/example/test/fixtures/source.ts": invalid,
		"packages/example/src/models.generated.ts": invalid,
		".tools/task.ts": invalid,
		"scripts/.hidden.ts": invalid,
		"tools/directory.ts/child.ts": invalid,
		"type.ts": 'export type Type = import("./missing.js").Type;\n',
		"lazy.ts": 'const lazy = () => import("./missing.js?raw");\n',
	});
	assert.equal(result.status, 1, result.stderr);
	for (const path of [
		"root.ts",
		"scripts/task.ts",
		"fixtures/source.ts",
		"models.generated.ts",
		".tools/task.ts",
		"scripts/.hidden.ts",
		"directory.ts/child.ts",
		"type.ts",
		"lazy.ts",
	]) {
		assert.ok(result.stderr.replaceAll("\\", "/").includes(`${path}:`), result.stderr);
	}
});

test("TypeScript import checks exclude declarations, git, coverage, builds, and dependencies", (t) => {
	const invalid = 'import "./missing.js";\n';
	const result = check(t, "./check-ts-relative-imports.mjs", {
		"root.ts": 'import "./missing.ts";\n',
		"declaration.d.ts": invalid,
		".git/source.ts": invalid,
		"coverage/source.ts": invalid,
		"dist/source.ts": invalid,
		"node_modules/source.ts": invalid,
		"packages/example/.git/source.ts": invalid,
		"packages/example/coverage/source.ts": invalid,
		"packages/example/dist/source.ts": invalid,
		"packages/example/node_modules/source.ts": invalid,
	});
	assert.equal(result.status, 0, result.stderr);
});
