#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildValueGraph, collectTypeScriptFiles, createWorkspaceResolver, normalizePath, reachableFiles } from "./lib/source-graphs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resolver = createWorkspaceResolver(ROOT);
const BUDGETS = {
	"packages/ai": {
		"./utils/*": { maxFiles: 3, forbid: ["providers/", "api/", "index.ts"] },
	},
	"packages/coding-agent": {
		".": {
			forbid: ["packages/coding-agent/src/modes/interactive/", "packages/coding-agent/src/presentation/", "packages/tui/src/"],
		},
	},
};

function relativeRoot(file) {
	return normalizePath(relative(ROOT, file));
}

function expandExport(packageName, subpath, target) {
	if (!subpath.includes("*")) return [[subpath, target]];
	const packageRoot = resolver.packageRoots.get(packageName).packageRoot;
	const targetDirectory = target.replace(/\*.*$/, "").replace(/^\.\/dist\//, "");
	const sourceDirectory = resolve(packageRoot, "src", targetDirectory);
	if (!existsSync(sourceDirectory)) return [];
	return readdirSync(sourceDirectory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
		.map((entry) => {
			const name = entry.name.replace(/\.ts$/, "");
			return [subpath.replace("*", name), target.replace("*", name)];
		});
}

function targetForExport(value) {
	return typeof value === "string" ? value : value.import ?? value.default ?? value.require;
}

function packageExportSource(packageName, subpath) {
	const entry = resolver.packageRoots.get(packageName);
	return resolver.resolveImport(subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`, resolve(entry.sourceRoot, "__entry_graph__.ts"));
}

function checkDeclaredExportBudgets() {
	const failures = [];
	for (const [packagePath, budgets] of Object.entries(BUDGETS)) {
		const packageName = [...resolver.packageRoots].find(([, entry]) => relativeRoot(entry.packageRoot) === packagePath)?.[0];
		const packageRoot = resolve(ROOT, packagePath);
		const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
		for (const [subpath, budget] of Object.entries(budgets)) {
			const declared = manifest.exports?.[subpath];
			if (!declared) {
				failures.push(`${packagePath} declares no export "${subpath}" but a graph rule exists for it`);
				continue;
			}
			const target = targetForExport(declared);
			for (const [name] of expandExport(packageName, subpath, target)) {
				const source = packageExportSource(packageName, name);
				if (!source) {
					failures.push(`${packagePath} export "${name}" has no source file resolved by its package exports map`);
					continue;
				}
				const graph = [...reachableFiles([source], resolver)].map(relativeRoot);
				if (budget.maxFiles !== undefined && graph.length > budget.maxFiles) {
					failures.push(`${packagePath} export "${name}" reaches ${graph.length} files, budget ${budget.maxFiles}\n${graph.map((file) => `    ${file}`).join("\n")}`);
				}
				for (const pattern of budget.forbid ?? []) {
					const hit = graph.filter((file) => file.includes(pattern));
					if (hit.length) failures.push(`${packagePath} export "${name}" must not reach ${pattern}:\n${hit.map((file) => `    ${file}`).join("\n")}`);
				}
			}
		}
	}
	return failures;
}

function checkDynamicRoots() {
	const failures = [];
	const reachability = [
		["packages/coding-agent/src/core/runtime-factory.ts", "packages/ai/src/providers/all.ts", "built-in provider catalog"],
		["packages/coding-agent/src/utils/image-resize.ts", "packages/coding-agent/src/utils/image-resize-worker.ts", "image resize worker"],
	];
	for (const [entryPath, targetPath, label] of reachability) {
		if (!reachableFiles([resolve(ROOT, entryPath)], resolver).has(resolve(ROOT, targetPath))) failures.push(`${label} is unreachable from ${entryPath}`);
	}
	const extensionHost = packageExportSource("@candy/coding-agent", "./extension-host-modules");
	const virtualModules = resolve(ROOT, "packages/coding-agent/src/presentation/extensions/virtual-modules.ts");
	if (!extensionHost || !reachableFiles([extensionHost], resolver).has(virtualModules)) failures.push("Extension host virtual-module map is unreachable from its package export");
	return failures;
}

export function findUnreachableSources(files, roots, sourceResolver) {
	const reached = buildValueGraph(roots, sourceResolver, { includeTypes: true });
	return files.filter((file) => !reached.has(file));
}

function checkSourceReachability() {
	const roots = [
		resolve(ROOT, "packages/coding-agent/src/bun/cli.ts"),
		resolve(ROOT, "packages/coding-agent/src/rpc-entry.ts"),
		resolve(ROOT, "packages/coding-agent/src/utils/source-resolver.ts"),
	];
	for (const [packageName, { packageRoot }] of resolver.packageRoots) {
		const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
		if (!manifest.exports) roots.push(packageExportSource(packageName, "."));
		for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
			for (const [name] of expandExport(packageName, subpath, targetForExport(value))) {
				const source = packageExportSource(packageName, name);
				if (source) roots.push(source);
			}
		}
		for (const target of Object.values(manifest.bin ?? {})) {
			roots.push(resolve(packageRoot, "src", target.replace(/^\.?\/?dist\/(?:bundle\/)?/, "").replace(/\.js$/, ".ts")));
		}
	}
	const files = [...resolver.packageRoots.values()].flatMap(({ sourceRoot }) => collectTypeScriptFiles(sourceRoot));
	return findUnreachableSources(files, roots, resolver).map((file) => `Source is unreachable from package exports, CLI entries, workers, or the development loader: ${relativeRoot(file)}`);
}

function checkCodingAgentAssets() {
	const packagePath = resolve(ROOT, "packages/coding-agent/package.json");
	const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
	const copyScripts = `${manifest.scripts["copy-assets"]}\n${manifest.scripts["copy-binary-assets"]}`;
	const assetPaths = [
		"src/modes/interactive/theme/dark.json",
		"src/modes/interactive/theme/light.json",
		"src/presentation/export-html/template.html",
		"src/presentation/export-html/template.css",
		"src/presentation/export-html/template.js",
	];
	const failures = [];
	for (const assetPath of assetPaths) {
		if (!existsSync(resolve(ROOT, "packages/coding-agent", assetPath))) failures.push(`Packaged asset is missing: packages/coding-agent/${assetPath}`);
		const copyPattern = assetPath.startsWith("src/modes/interactive/theme/")
			? "src/modes/interactive/theme/*.json"
			: assetPath.startsWith("src/presentation/export-html/")
				? `src/presentation/export-html/${assetPath.split("/").at(-1)}`
				: assetPath;
		if (!copyScripts.includes(copyPattern)) failures.push(`Build asset is not copied by package scripts: packages/coding-agent/${assetPath}`);
	}
	return failures;
}

export function checkEntryGraphFailures() {
	return [...checkDeclaredExportBudgets(), ...checkDynamicRoots(), ...checkSourceReachability(), ...checkCodingAgentAssets()];
}

export function runEntryGraphCheck() {
	const failures = checkEntryGraphFailures();
	if (failures.length) {
		console.error(`${failures.join("\n")}\n\n${failures.length} entry-point graph violation(s).`);
		process.exitCode = 1;
	} else console.log("Package export graphs, dynamic roots, and packaged assets are within their boundaries.");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runEntryGraphCheck();
