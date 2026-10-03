#!/usr/bin/env node
import { existsSync, globSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	buildValueGraph,
	createSourceScanner,
	createWorkspaceResolver,
	normalizePath,
	packageExportTarget,
	reachableFiles,
} from "./lib/source-graphs.mjs";

import { codingAgentAssetPatterns, codingAgentRequiredAssets } from "./copy-coding-agent-assets.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function createSourceGraphContext() {
	const resolver = createWorkspaceResolver(ROOT);
	const scanner = createSourceScanner(
		resolver,
		[...resolver.packageRoots.values()].map(({ sourceRoot }) => sourceRoot),
	);
	return { resolver, scanner };
}
const BUDGETS = {
	"packages/ai": {
		"./utils/*": { maxFiles: 3, forbid: ["providers/", "api/", "index.ts"] },
	},
	"packages/coding-agent": {
		".": {
			forbid: [
				"packages/coding-agent/src/modes/interactive/",
				"packages/coding-agent/src/presentation/",
				"packages/tui/src/",
			],
		},
	},
};

function relativeRoot(file) {
	return normalizePath(relative(ROOT, file));
}

function expandExport(packageName, subpath, target, resolver) {
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

function packageExportSource(packageName, subpath, resolver) {
	const entry = resolver.packageRoots.get(packageName);
	return resolver.resolveImport(
		subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`,
		resolve(entry.sourceRoot, "__entry_graph__.ts"),
	);
}

export function checkExportGraphBudget(packagePath, name, graph, budget) {
	const failures = [];
	if (budget.maxFiles !== undefined && graph.length > budget.maxFiles) {
		failures.push(
			`${packagePath} export "${name}" reaches ${graph.length} files, budget ${budget.maxFiles}\n${graph.map((file) => `    ${file}`).join("\n")}`,
		);
	}
	for (const pattern of budget.forbid ?? []) {
		const hit = graph.filter((file) => file.includes(pattern));
		if (hit.length)
			failures.push(
				`${packagePath} export "${name}" must not reach ${pattern}:\n${hit.map((file) => `    ${file}`).join("\n")}`,
			);
	}
	return failures;
}

function checkDeclaredExportBudgets({ resolver, scanner }) {
	const failures = [];
	for (const [packagePath, budgets] of Object.entries(BUDGETS)) {
		const packageName = [...resolver.packageRoots].find(
			([, entry]) => relativeRoot(entry.packageRoot) === packagePath,
		)?.[0];
		const { manifest } = resolver.packageRoots.get(packageName);
		for (const [subpath, budget] of Object.entries(budgets)) {
			const declared = manifest.exports?.[subpath];
			if (!declared) {
				failures.push(`${packagePath} declares no export "${subpath}" but a graph rule exists for it`);
				continue;
			}
			const target = packageExportTarget(declared);
			for (const [name] of expandExport(packageName, subpath, target, resolver)) {
				const source = packageExportSource(packageName, name, resolver);
				if (!source) {
					failures.push(`${packagePath} export "${name}" has no source file resolved by its package exports map`);
					continue;
				}
				const graph = [...reachableFiles([source], resolver, scanner)].map(relativeRoot);
				failures.push(...checkExportGraphBudget(packagePath, name, graph, budget));
			}
		}
	}
	return failures;
}

function checkDynamicRoots({ resolver, scanner }) {
	const failures = [];
	const reachability = [
		[
			"packages/coding-agent/src/core/runtime-factory.ts",
			"packages/ai/src/providers/all.ts",
			"built-in provider catalog",
		],
		[
			"packages/coding-agent/src/utils/image-resize.ts",
			"packages/coding-agent/src/utils/image-resize-worker.ts",
			"image resize worker",
		],
	];
	for (const [entryPath, targetPath, label] of reachability) {
		if (!reachableFiles([resolve(ROOT, entryPath)], resolver, scanner).has(resolve(ROOT, targetPath)))
			failures.push(`${label} is unreachable from ${entryPath}`);
	}
	const extensionHost = packageExportSource("@candy/coding-agent", "./extension-host-modules", resolver);
	const virtualModules = resolve(ROOT, "packages/coding-agent/src/presentation/extensions/virtual-modules.ts");
	if (!extensionHost || !reachableFiles([extensionHost], resolver, scanner).has(virtualModules))
		failures.push("Extension host virtual-module map is unreachable from its package export");
	return failures;
}

export function findUnreachableSources(files, roots, sourceResolver, scanner = createSourceScanner(sourceResolver)) {
	const reached = buildValueGraph(roots, sourceResolver, { includeTypes: true, scanner });
	return files.filter((file) => !reached.has(file));
}

function checkSourceReachability({ resolver, scanner }) {
	const roots = [
		resolve(ROOT, "packages/coding-agent/src/bun/cli.ts"),
		resolve(ROOT, "packages/coding-agent/src/rpc-entry.ts"),
		resolve(ROOT, "packages/coding-agent/src/utils/source-resolver.ts"),
	];
	for (const [packageName, { packageRoot, manifest }] of resolver.packageRoots) {
		if (!manifest.exports) roots.push(packageExportSource(packageName, ".", resolver));
		for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
			for (const [name] of expandExport(packageName, subpath, packageExportTarget(value), resolver)) {
				const source = packageExportSource(packageName, name, resolver);
				if (source) roots.push(source);
			}
		}
		for (const target of Object.values(manifest.bin ?? {})) {
			roots.push(
				resolve(packageRoot, "src", target.replace(/^\.?\/?dist\/(?:bundle\/)?/, "").replace(/\.js$/, ".ts")),
			);
		}
	}
	const files = scanner.files;
	return findUnreachableSources(files, roots, resolver, scanner).map(
		(file) =>
			`Source is unreachable from package exports, CLI entries, workers, or the development loader: ${relativeRoot(file)}`,
	);
}

function checkCodingAgentAssets({ resolver }) {
	const { packageRoot } = resolver.packageRoots.get("@candy/coding-agent");
	const failures = [];
	for (const assetPath of new Set([...codingAgentRequiredAssets, ...codingAgentAssetPatterns])) {
		if (globSync(assetPath, { cwd: packageRoot }).length === 0)
			failures.push(`Packaged asset is missing: packages/coding-agent/${assetPath}`);
	}
	return failures;
}

function checkEntryGraphFailures(context) {
	return [
		...checkDeclaredExportBudgets(context),
		...checkDynamicRoots(context),
		...checkSourceReachability(context),
		...checkCodingAgentAssets(context),
	];
}

export function findRuntimeCycles(graph) {
	let nextIndex = 0;
	const indices = new Map();
	const lowLinks = new Map();
	const stack = [];
	const onStack = new Set();
	const cycles = [];

	function visit(node) {
		indices.set(node, nextIndex);
		lowLinks.set(node, nextIndex);
		nextIndex += 1;
		stack.push(node);
		onStack.add(node);
		for (const neighbor of graph.get(node) ?? []) {
			if (!indices.has(neighbor)) {
				visit(neighbor);
				lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(neighbor)));
			} else if (onStack.has(neighbor)) lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(neighbor)));
		}
		if (lowLinks.get(node) !== indices.get(node)) return;
		const component = [];
		let member;
		do {
			member = stack.pop();
			onStack.delete(member);
			component.push(member);
		} while (member !== node);
		if (component.length > 1 || graph.get(node)?.has(node)) cycles.push(component.sort());
	}

	for (const node of graph.keys()) if (!indices.has(node)) visit(node);
	return cycles;
}

function presentationModule(file, resolver) {
	const normalized = relativeRoot(file);
	return (
		normalized.startsWith("packages/coding-agent/src/modes/interactive/") ||
		normalized.startsWith("packages/coding-agent/src/presentation/") ||
		resolver.packageName(file) === "@candy/tui"
	);
}

export function checkArchitecture(
	graph,
	resolver = createWorkspaceResolver(ROOT),
	sourceFiles = [...graph.keys()],
	scanner = createSourceScanner(resolver),
) {
	const failures = [];
	const forbiddenTargets = new Map([
		["@candy/ai", new Set(["@candy/agent-core", "@candy/coding-agent", "@candy/tui"])],
		["@candy/agent-core", new Set(["@candy/coding-agent", "@candy/tui"])],
		["@candy/tui", new Set(["@candy/ai", "@candy/agent-core", "@candy/coding-agent"])],
	]);

	for (const [file, targets] of graph) {
		const importerPackage = resolver.packageName(file);
		for (const target of targets) {
			const targetPackage = resolver.packageName(target);
			if (forbiddenTargets.get(importerPackage)?.has(targetPackage)) {
				failures.push(
					`${relativeRoot(file)} imports ${relativeRoot(target)}; ${importerPackage} must not depend on ${targetPackage}`,
				);
			}
			if (
				importerPackage === "@candy/coding-agent" &&
				relativeRoot(file).startsWith("packages/coding-agent/src/core/") &&
				presentationModule(target, resolver)
			) {
				failures.push(`${relativeRoot(file)} imports presentation module ${relativeRoot(target)}`);
			}
		}
	}

	for (const file of sourceFiles) {
		if (resolver.packageName(file) !== "@candy/coding-agent") continue;
		if (!relativeRoot(file).startsWith("packages/coding-agent/src/core/")) continue;
		for (const target of scanner.dependencies(file).types) {
			if (presentationModule(target, resolver) && resolver.packageName(target) !== "@candy/tui") {
				failures.push(`${relativeRoot(file)} has a type dependency on presentation module ${relativeRoot(target)}`);
			}
		}
	}

	for (const cycle of findRuntimeCycles(graph)) {
		failures.push(`Runtime import cycle:\n${cycle.map((file) => `  ${relativeRoot(file)}`).join("\n")}`);
	}
	return failures;
}

export function checkSourceGraphFailures(rules = ["entry-graphs", "architecture"]) {
	const context = createSourceGraphContext();
	const failures = [];
	for (const rule of rules) {
		if (rule === "entry-graphs") failures.push(...checkEntryGraphFailures(context));
		else if (rule === "architecture") {
			const { resolver, scanner } = context;
			const graph = buildValueGraph(scanner.files, resolver, { scanner });
			failures.push(...checkArchitecture(graph, resolver, scanner.files, scanner));
		} else throw new Error(`Unknown source graph rule: ${rule}`);
	}
	return failures;
}

export function runSourceGraphCheck(args = process.argv.slice(2)) {
	const rules = [];
	for (let index = 0; index < args.length; index += 2) {
		if (args[index] !== "--rule" || !["entry-graphs", "architecture"].includes(args[index + 1])) {
			throw new Error("Usage: check-source-graphs.mjs [--rule entry-graphs] [--rule architecture]");
		}
		rules.push(args[index + 1]);
	}
	const failures = checkSourceGraphFailures(rules.length ? rules : undefined);
	if (failures.length) {
		console.error(`${failures.join("\n")}\n\n${failures.length} source graph violation(s).`);
		process.exitCode = 1;
	} else
		console.log(
			`Source graph checks passed: ${(rules.length ? rules : ["entry-graphs", "architecture"]).join(", ")}.`,
		);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runSourceGraphCheck();
