#!/usr/bin/env node
import { chmodSync, cpSync, globSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const codingAgentAssetPatterns = [
	"src/modes/interactive/theme/*.json",
	"src/presentation/export-html/template.html",
	"src/presentation/export-html/template.css",
	"src/presentation/export-html/template.js",
	"src/presentation/export-html/vendor/*.js",
];

export const codingAgentRequiredAssets = [
	"src/modes/interactive/theme/dark.json",
	"src/modes/interactive/theme/light.json",
	...codingAgentAssetPatterns.filter((pattern) => !pattern.includes("*")),
];

export function copyCodingAgentAssets({
	packageRoot = resolve(ROOT, "packages/coding-agent"),
	repositoryRoot = ROOT,
	binary = false,
} = {}) {
	const dist = resolve(packageRoot, "dist");
	for (const pattern of codingAgentAssetPatterns) {
		const files = globSync(pattern, { cwd: packageRoot });
		if (files.length === 0) throw new Error(`Build asset pattern matched no files: ${pattern}`);
		for (const file of files) {
			const destination = resolve(dist, file.slice("src/".length));
			mkdirSync(dirname(destination), { recursive: true });
			cpSync(resolve(packageRoot, file), destination);
		}
	}
	for (const entry of ["cli.js", "rpc-entry.js"]) chmodSync(resolve(dist, entry), 0o755);
	mkdirSync(resolve(dist, "codemode"), { recursive: true });
	cpSync(resolve(repositoryRoot, "node_modules/quickjs-wasi/quickjs.wasm"), resolve(dist, "codemode/quickjs.wasm"));
	if (binary) {
		for (const file of ["package.json", "README.md", "CHANGELOG.md", "docs", "examples"]) {
			cpSync(resolve(packageRoot, file), resolve(dist, file), { recursive: true });
		}
		cpSync(
			resolve(repositoryRoot, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"),
			resolve(dist, "photon_rs_bg.wasm"),
		);
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const args = process.argv.slice(2);
	if (args.length > 1 || (args.length === 1 && args[0] !== "--binary"))
		throw new Error("Usage: copy-coding-agent-assets.mjs [--binary]");
	copyCodingAgentAssets({ binary: args[0] === "--binary" });
}
