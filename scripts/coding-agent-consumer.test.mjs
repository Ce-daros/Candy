import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installCodingAgentConsumer, packReleasePackages, smokeTestCodingAgentConsumer } from "./coding-agent-consumer.mjs";

const codingAgentName = "@candy/coding-agent";

function createFixture(t, { importMissing = false, includeExperimental = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "candy-consumer-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const packageDirectory = join(root, "packages", "coding-agent");
	const manifest = {
		name: codingAgentName,
		version: "1.0.0",
		type: "module",
		bin: { candy: "dist/bundle/cli.js" },
		main: "./dist/index.js",
		exports: {
			".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
			"./rpc-entry": { import: "./dist/bundle/rpc-entry.js" },
		},
	};
	const files = {
		"package.json": JSON.stringify(manifest),
		"dist/index.js": `${importMissing ? 'import "@candy/missing";\n' : ""}export async function createAgentSessionRuntime() { let disposed = false; return { session: { prompt() {}, get isDisposed() { return disposed; } }, async dispose() { disposed = true; } }; }\n`,
		"dist/cli.js": 'console.log("1.0.0");',
		"dist/bundle/cli.js": 'console.log(process.argv.includes("--version") ? "1.0.0" : "PUBLISHED_FAUX_REPLY_OK");',
	};
	if (includeExperimental) files["dist/experimental/obsolete.js"] = "export {};";
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(packageDirectory, path)), { recursive: true });
		writeFileSync(join(packageDirectory, path), content);
	}
	const tarballs = packReleasePackages([{ directory: packageDirectory, name: codingAgentName }], join(root, "tarballs"));
	const directory = join(root, "consumer");
	installCodingAgentConsumer(directory, tarballs);
	return directory;
}

test("installs and runs the SDK and CLI from the published package", (t) => {
	const directory = createFixture(t);
	const manifest = JSON.parse(readFileSync(join(directory, "node_modules", codingAgentName, "package.json"), "utf8"));
	assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
	smokeTestCodingAgentConsumer(directory);
	for (const subpath of ["/core/runtime-factory", "/modes/interactive/interactive-mode"]) {
		assert.throws(() => import.meta.resolve(`${codingAgentName}${subpath}`), /not exported|not defined/);
	}
});

test("fails when the SDK imports an undeclared package", (t) => {
	const directory = createFixture(t, { importMissing: true });
	assert.throws(() => smokeTestCodingAgentConsumer(directory), /Cannot find package '@candy\/missing'/);
});

test("rejects experimental files from the published package", (t) => {
	const directory = createFixture(t, { includeExperimental: true });
	assert.ok(existsSync(join(directory, "node_modules", codingAgentName, "dist/experimental")));
	assert.throws(() => smokeTestCodingAgentConsumer(directory), /contains development-only code/);
});
