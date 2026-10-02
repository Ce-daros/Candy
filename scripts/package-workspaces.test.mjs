import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { workspaceSourceAliases } from "./lib/workspace-paths.mjs";
import { findPackageDirectories } from "./package-workspaces.mjs";

test("finds declared workspace globs and fixtures without collecting unlisted nested packages", (t) => {
	const root = mkdtempSync(resolve(tmpdir(), "candy-workspaces-"));
	t.after(() => rmSync(root, { recursive: true }));
	const files = {
		"package.json": JSON.stringify({
			workspaces: ["packages/*", "packages/example/test/fixtures/with-deps", "packages/example"],
		}),
		"packages/example/package.json": JSON.stringify({ name: "@candy/example" }),
		"packages/example/test/fixtures/with-deps/package.json": JSON.stringify({ name: "fixture" }),
		"packages/example/test/fixtures/unlisted/package.json": JSON.stringify({ name: "unlisted" }),
		"other/package.json": JSON.stringify({ name: "other" }),
	};
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(dirname(resolve(root, file)), { recursive: true });
		writeFileSync(resolve(root, file), content);
	}
	assert.deepEqual(
		findPackageDirectories(root),
		["packages/example", "packages/example/test/fixtures/with-deps"]
			.map((directory) => relative(process.cwd(), resolve(root, directory)))
			.sort(),
	);
});

test("derives exact and wildcard source aliases from TypeScript paths", (t) => {
	const root = mkdtempSync(resolve(tmpdir(), "candy-source-aliases-"));
	t.after(() => rmSync(root, { recursive: true }));
	writeFileSync(
		resolve(root, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				paths: {
					"@candy/example/*": ["./packages/example/src/*"],
					"@candy/example/special": ["./packages/example/src/actual.ts"],
					"@candy/example": ["./packages/example/src/index.ts"],
					typebox: ["./node_modules/typebox"],
				},
			},
		}),
	);
	const aliases = workspaceSourceAliases(root);
	const mapped = (specifier) => {
		const alias = aliases.find(({ find }) => find.test(specifier));
		return specifier.replace(alias.find, alias.replacement);
	};
	assert.equal(aliases.length, 3);
	assert.equal(
		mapped("@candy/example/special"),
		resolve(root, "packages/example/src/actual.ts").replaceAll("\\", "/"),
	);
	assert.equal(
		mapped("@candy/example/utils/tool"),
		resolve(root, "packages/example/src/utils/tool").replaceAll("\\", "/"),
	);
	assert.equal(mapped("@candy/example"), resolve(root, "packages/example/src/index.ts").replaceAll("\\", "/"));
});
