import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildValueGraph, collectTypeSpecifiers, collectTypeScriptFiles, createWorkspaceResolver, normalizePath } from "./lib/source-graphs.mjs";
import { workspacePackages } from "./lib/workspace-paths.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");
const WORKSPACE = workspacePackages(ROOT);
const SOURCE_ROOTS = [...WORKSPACE.values()];

export function normalizeWorkspacePath(filePath) {
	return normalizePath(filePath);
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

function packageName(file, resolver) {
	return resolver.packageName(file);
}

function presentationModule(file, resolver) {
	const normalized = normalizeWorkspacePath(relative(ROOT, file));
	return (
		normalized.startsWith("packages/coding-agent/src/modes/interactive/") ||
		normalized.startsWith("packages/coding-agent/src/presentation/") ||
		packageName(file, resolver) === "@candy/tui"
	);
}

export function checkArchitecture(graph, resolver = createWorkspaceResolver(ROOT), sourceFiles = [...graph.keys()]) {
	const failures = [];
	const forbiddenTargets = new Map([
		["@candy/ai", new Set(["@candy/agent-core", "@candy/coding-agent", "@candy/tui"])],
		["@candy/agent-core", new Set(["@candy/coding-agent", "@candy/tui"])],
		["@candy/tui", new Set(["@candy/ai", "@candy/agent-core", "@candy/coding-agent"])],
	]);

	for (const [file, targets] of graph) {
		const importerPackage = packageName(file, resolver);
		for (const target of targets) {
			const targetPackage = packageName(target, resolver);
			if (forbiddenTargets.get(importerPackage)?.has(targetPackage)) {
				failures.push(
					`${normalizeWorkspacePath(relative(ROOT, file))} imports ${normalizeWorkspacePath(relative(ROOT, target))}; ${importerPackage} must not depend on ${targetPackage}`,
				);
			}
			if (importerPackage === "@candy/coding-agent" && normalizeWorkspacePath(relative(ROOT, file)).startsWith("packages/coding-agent/src/core/") && presentationModule(target, resolver)) {
				failures.push(`${normalizeWorkspacePath(relative(ROOT, file))} imports presentation module ${normalizeWorkspacePath(relative(ROOT, target))}`);
			}
		}
	}

	for (const file of sourceFiles) {
		if (packageName(file, resolver) !== "@candy/coding-agent") continue;
		if (!normalizeWorkspacePath(relative(ROOT, file)).startsWith("packages/coding-agent/src/core/")) continue;
		for (const specifier of collectTypeSpecifiers(file)) {
			const target = resolver.resolveImport(specifier, file);
			if (target && presentationModule(target, resolver) && packageName(target, resolver) !== "@candy/tui") {
				failures.push(`${normalizeWorkspacePath(relative(ROOT, file))} has a type dependency on presentation module ${normalizeWorkspacePath(relative(ROOT, target))}`);
			}
		}
	}

	for (const cycle of findRuntimeCycles(graph)) {
		failures.push(`Runtime import cycle:\n${cycle.map((file) => `  ${normalizeWorkspacePath(relative(ROOT, file))}`).join("\n")}`);
	}
	return failures;
}

export function runArchitectureCheck() {
	const resolver = createWorkspaceResolver(ROOT);
	const sourceFiles = SOURCE_ROOTS.flatMap((sourceRoot) => collectTypeScriptFiles(resolve(ROOT, sourceRoot)));
	const graph = buildValueGraph(sourceFiles, resolver);
	const failures = checkArchitecture(graph, resolver, sourceFiles);
	if (failures.length) {
		console.error(failures.join("\n"));
		process.exitCode = 1;
	} else {
		console.log("Runtime and type dependency boundaries hold and no unexpected runtime import cycles remain.");
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runArchitectureCheck();
