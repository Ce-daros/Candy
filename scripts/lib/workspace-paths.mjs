/**
 * Workspace package names and their source roots come from `tsconfig.json`
 * `compilerOptions.paths`, the same table Node uses at runtime (see
 * `packages/coding-agent/src/utils/source-resolver.ts`) and the one editors
 * type-check against. Check scripts, vitest aliases, and the interactive smoke
 * bundle read it here instead of restating the table.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * `@candy/name` -> repository-relative source root, e.g. `@candy/agent-core` ->
 * `packages/agent/src`. Only bare package entries count; subpath entries such
 * as `@candy/telemetry/testing` and wildcard entries are skipped.
 */
export function workspacePackages(root = repositoryRoot) {
	const tsconfigPath = resolve(root, "tsconfig.json");
	const { compilerOptions } = JSON.parse(readFileSync(tsconfigPath, "utf8"));
	const paths = compilerOptions?.paths;
	if (!paths) throw new Error(`${tsconfigPath} has no compilerOptions.paths`);

	const packages = new Map();
	for (const [pattern, replacements] of Object.entries(paths)) {
		if (!pattern.startsWith("@candy/") || pattern.includes("*")) continue;
		if (pattern.split("/").length !== 2) continue;
		const [target] = replacements;
		if (typeof target !== "string" || !target.endsWith("/index.ts")) continue;
		const sourceRoot = target.slice(0, -"/index.ts".length).replace(/^\.\//, "");
		packages.set(pattern, sourceRoot.replaceAll("\\", "/"));
	}
	return packages;
}
