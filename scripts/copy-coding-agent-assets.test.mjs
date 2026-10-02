import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { copyCodingAgentAssets } from "./copy-coding-agent-assets.mjs";

function fixture(t) {
	const repositoryRoot = mkdtempSync(resolve(tmpdir(), "candy-assets-"));
	t.after(() => rmSync(repositoryRoot, { recursive: true }));
	const packageRoot = resolve(repositoryRoot, "packages/coding-agent");
	const files = [
		"dist/cli.js",
		"dist/rpc-entry.js",
		"package.json",
		"README.md",
		"CHANGELOG.md",
		"src/modes/interactive/theme/dark.json",
		"src/modes/interactive/theme/light.json",
		"src/presentation/export-html/template.html",
		"src/presentation/export-html/template.css",
		"src/presentation/export-html/template.js",
		"src/presentation/export-html/vendor/highlight.js",
		"docs/usage.md",
		"examples/rpc-example.ts",
	];
	for (const file of files) {
		mkdirSync(dirname(resolve(packageRoot, file)), { recursive: true });
		writeFileSync(resolve(packageRoot, file), file);
	}
	const wasm = resolve(repositoryRoot, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm");
	mkdirSync(dirname(wasm), { recursive: true });
	writeFileSync(wasm, new Uint8Array([0, 97, 115, 109]));
	return { repositoryRoot, packageRoot, files };
}

for (const binary of [false, true]) {
	test(`copies ${binary ? "binary" : "package"} assets and keeps CLI entries executable`, (t) => {
		const { repositoryRoot, packageRoot, files } = fixture(t);
		copyCodingAgentAssets({ repositoryRoot, packageRoot, binary });
		for (const file of files.filter((file) => file.startsWith("src/"))) {
			assert.equal(readFileSync(resolve(packageRoot, "dist", file.slice(4)), "utf8"), file);
		}
		if (process.platform !== "win32") {
			for (const entry of ["cli.js", "rpc-entry.js"])
				assert.equal(statSync(resolve(packageRoot, "dist", entry)).mode & 0o777, 0o755);
		}
		assert.equal(existsSync(resolve(packageRoot, "dist/docs/usage.md")), binary);
		assert.equal(existsSync(resolve(packageRoot, "dist/examples/rpc-example.ts")), binary);
		if (binary) {
			for (const file of ["package.json", "README.md", "CHANGELOG.md"])
				assert.equal(readFileSync(resolve(packageRoot, "dist", file), "utf8"), file);
			assert.deepEqual(readFileSync(resolve(packageRoot, "dist/photon_rs_bg.wasm")), Buffer.from([0, 97, 115, 109]));
		}
	});
}

test("fails when required asset globs match no files", (t) => {
	const { repositoryRoot, packageRoot } = fixture(t);
	rmSync(resolve(packageRoot, "src/modes/interactive/theme/dark.json"));
	rmSync(resolve(packageRoot, "src/modes/interactive/theme/light.json"));
	assert.throws(() => copyCodingAgentAssets({ repositoryRoot, packageRoot }), /Build asset pattern matched no files/);
});
