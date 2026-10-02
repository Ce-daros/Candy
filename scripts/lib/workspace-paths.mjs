import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export function workspaceSourcePaths(root = repositoryRoot) {
	const tsconfigPath = resolve(root, "tsconfig.json");
	const { compilerOptions } = JSON.parse(readFileSync(tsconfigPath, "utf8"));
	if (!compilerOptions.paths) throw new Error(`${tsconfigPath} has no compilerOptions.paths`);
	return Object.entries(compilerOptions.paths).filter(([pattern]) => pattern.startsWith("@candy/"));
}

export function workspacePackages(root = repositoryRoot) {
	const packages = new Map();
	for (const [pattern, [target]] of workspaceSourcePaths(root)) {
		if (pattern.includes("*") || pattern.split("/").length !== 2) continue;
		if (!target.endsWith("/index.ts")) throw new Error(`Workspace package ${pattern} must map to its source index`);
		packages.set(pattern, target.slice(0, -"/index.ts".length).replace(/^\.\//, "").replaceAll("\\", "/"));
	}
	return packages;
}

export function workspaceSourceAliases(root = repositoryRoot) {
	return workspaceSourcePaths(root)
		.sort(([left], [right]) => Number(left.includes("*")) - Number(right.includes("*")))
		.map(([pattern, [target]]) => ({
			find: new RegExp(
				`^${pattern
					.split("*")
					.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
					.join("(.+)")}$`,
			),
			replacement: resolve(root, target).replaceAll("\\", "/").replace("*", "$1"),
		}));
}
