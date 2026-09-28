import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformSync } from "esbuild";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");
const WORKSPACE = new Map([
	["@candy/ai", "packages/ai/src"],
	["@candy/agent-core", "packages/agent/src"],
	["@candy/coding-agent", "packages/coding-agent/src"],
	["@candy/telemetry", "packages/telemetry/src"],
	["@candy/tui", "packages/tui/src"],
]);
const SOURCE_ROOTS = [...WORKSPACE.values()];

export function normalizeWorkspacePath(filePath) {
	return filePath.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
}

function collectSourceFiles(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectSourceFiles(path));
		} else if (entry.isFile() && [".ts", ".mts", ".cts"].includes(extname(entry.name)) && !entry.name.endsWith(".d.ts")) {
			files.push(path);
		}
	}
	return files;
}

function resolveSourcePath(basePath) {
	for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.mts`, `${basePath}.cts`, resolve(basePath, "index.ts")]) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {}
	}
	return undefined;
}

function resolveWorkspaceImport(specifier, importer) {
	if (specifier.startsWith(".")) return resolveSourcePath(resolve(dirname(importer), specifier));
	for (const [packageName, packageRoot] of WORKSPACE) {
		if (specifier === packageName) return resolveSourcePath(resolve(ROOT, packageRoot, "index"));
		if (!specifier.startsWith(`${packageName}/`)) continue;
		const tail = specifier.slice(packageName.length + 1);
		return resolveSourcePath(resolve(ROOT, packageRoot, tail));
	}
	return undefined;
}

function collectValueSpecifiers(file) {
	const { code } = transformSync(readFileSync(file, "utf8"), {
		loader: extname(file).slice(1),
		format: "esm",
		legalComments: "none",
	});
	const specifiers = [];
	const staticImports = /(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']/g;
	const dynamicImports = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
	for (const match of code.matchAll(staticImports)) specifiers.push(match[1]);
	for (const match of code.matchAll(dynamicImports)) specifiers.push(match[1]);
	return specifiers;
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
			} else if (onStack.has(neighbor)) {
				lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(neighbor)));
			}
		}

		if (lowLinks.get(node) !== indices.get(node)) return;
		const component = [];
		let member;
		do {
			member = stack.pop();
			onStack.delete(member);
			component.push(member);
		} while (member !== node);

		if (component.length > 1 || graph.get(node)?.has(node)) {
			cycles.push(component.sort());
		}
	}

	for (const node of graph.keys()) {
		if (!indices.has(node)) visit(node);
	}
	return cycles;
}

function buildRuntimeGraph(files) {
	const graph = new Map();
	for (const file of files) {
		const targets = new Set();
		for (const specifier of collectValueSpecifiers(file)) {
			const target = resolveWorkspaceImport(specifier, file);
			const normalizedFile = normalizeWorkspacePath(relative(ROOT, file));
			const normalizedTarget = target && normalizeWorkspacePath(relative(ROOT, target));
			if (target) targets.add(target);
		}
		graph.set(file, targets);
	}
	return graph;
}

function packageName(filePath) {
	const normalized = normalizeWorkspacePath(relative(ROOT, filePath));
	return [...WORKSPACE].find(([, packageRoot]) => normalized.startsWith(`${packageRoot}/`))?.[0];
}

export function checkArchitecture(graph) {
	const failures = [];
	const forbiddenTargets = new Map([
		["@candy/ai", new Set(["@candy/agent-core", "@candy/coding-agent", "@candy/tui"])],
		["@candy/agent-core", new Set(["@candy/coding-agent", "@candy/tui"])],
		["@candy/tui", new Set(["@candy/ai", "@candy/agent-core", "@candy/coding-agent"])],
	]);

	for (const [file, targets] of graph) {
		const importerPackage = packageName(file);
		for (const target of targets) {
			const targetPackage = packageName(target);
			if (forbiddenTargets.get(importerPackage)?.has(targetPackage)) {
				failures.push(
					`${normalizeWorkspacePath(relative(ROOT, file))} imports ${normalizeWorkspacePath(relative(ROOT, target))}; ${importerPackage} must not depend on ${targetPackage}`,
				);
			}
			const normalizedImporter = normalizeWorkspacePath(relative(ROOT, file));
			const normalizedTarget = normalizeWorkspacePath(relative(ROOT, target));
			if (normalizedImporter.startsWith("packages/coding-agent/src/core/")) {
				const presentationTarget =
					normalizedTarget.startsWith("packages/coding-agent/src/modes/interactive/") ||
					normalizedTarget.startsWith("packages/coding-agent/src/presentation/") ||
					targetPackage === "@candy/tui";
				if (presentationTarget) {
					failures.push(`${normalizedImporter} imports presentation module ${normalizedTarget}`);
				}
			}
		}
	}

	for (const cycle of findRuntimeCycles(graph)) {
		failures.push(`Runtime import cycle:\n${cycle.map((file) => `  ${normalizeWorkspacePath(relative(ROOT, file))}`).join("\n")}`);
	}
	return failures;
}

export function runArchitectureCheck() {
	const files = SOURCE_ROOTS.flatMap((sourceRoot) => collectSourceFiles(resolve(ROOT, sourceRoot)));
	const failures = checkArchitecture(buildRuntimeGraph(files));
	if (failures.length) {
		console.error(failures.join("\n"));
		process.exitCode = 1;
	} else {
		console.log("Runtime/UI dependency boundaries hold and no unexpected runtime import cycles remain.");
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	runArchitectureCheck();
}
