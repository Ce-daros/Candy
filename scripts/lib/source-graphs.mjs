import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { transformSync } from "esbuild";
import { repositoryRoot, workspacePackages } from "./workspace-paths.mjs";

const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts"];

export function normalizePath(path) {
	return path.split(sep).join("/").replaceAll("\\", "/").replace(/\/{2,}/g, "/");
}

export function collectTypeScriptFiles(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) files.push(...collectTypeScriptFiles(path));
		else if (entry.isFile() && SOURCE_EXTENSIONS.includes(extname(entry.name)) && !entry.name.endsWith(".d.ts")) files.push(path);
	}
	return files;
}

export function collectValueSpecifiers(file) {
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
	const source = readFileSync(file, "utf8");
	const relativeAssets = /["'](\.\.?\/[^"']+\.(?:ts|js))["']/g;
	for (const match of source.matchAll(relativeAssets)) {
		const context = source.slice(Math.max(0, match.index - 100), match.index + 300);
		if (context.includes("new URL(") && context.includes("import.meta.url")) specifiers.push(match[1]);
	}
	return specifiers;
}

export function collectTypeSpecifiers(file) {
	const source = readFileSync(file, "utf8");
	const specifiers = [];
	const declarations = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^'";]*?\sfrom\s*)["']([^"']+)["']/g;
	for (const match of source.matchAll(declarations)) {
		if (match[2] || /\btype\s+[A-Za-z_$]/.test(match[3])) specifiers.push(match[4]);
	}
	const importTypes = /\b(?:typeof\s+)?import\s*\(\s*["']([^"']+)["']\s*\)\s*\.[A-Za-z_$]/g;
	for (const match of source.matchAll(importTypes)) specifiers.push(match[1]);
	return specifiers;
}

function sourceForExport(packageRoot, target) {
	if (typeof target !== "string") return undefined;
	const sourceRelative = target.replace(/^\.\/dist\//, "").replace(/\.d?\.ts$/, ".ts").replace(/\.js$/, ".ts");
	const sourcePath = resolve(packageRoot, "src", sourceRelative);
	return existsSync(sourcePath) && statSync(sourcePath).isFile() ? sourcePath : undefined;
}

function exportTarget(exports, subpath) {
	const exact = exports?.[subpath];
	if (exact) return typeof exact === "string" ? exact : exact.import ?? exact.default ?? exact.require;
	for (const [pattern, value] of Object.entries(exports ?? {})) {
		if (!pattern.includes("*")) continue;
		const [prefix, suffix] = pattern.split("*");
		if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
		const capture = subpath.slice(prefix.length, subpath.length - suffix.length);
		const target = typeof value === "string" ? value : value.import ?? value.default ?? value.require;
		return target?.replaceAll("*", capture);
	}
	return undefined;
}

export function createWorkspaceResolver(root = repositoryRoot) {
	const packageRoots = new Map();
	for (const [name, sourceRoot] of workspacePackages(root)) {
		const packageRoot = resolve(root, dirname(sourceRoot));
		const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
		packageRoots.set(name, { packageRoot, sourceRoot: resolve(root, sourceRoot), exports: manifest.exports });
	}

	function resolveSourcePath(basePath) {
		const normalizedBase = basePath.replace(/\.js$/, ".ts");
		for (const candidate of [normalizedBase, ...SOURCE_EXTENSIONS.map((extension) => `${normalizedBase}${extension}`), ...SOURCE_EXTENSIONS.map((extension) => resolve(normalizedBase, `index${extension}`))]) {
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		}
	}

	function resolveImport(specifier, importer) {
		if (specifier.startsWith(".")) return resolveSourcePath(resolve(dirname(importer), specifier));
		for (const [name, entry] of packageRoots) {
			if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
			const subpath = specifier === name ? "." : `./${specifier.slice(name.length + 1)}`;
			const target = exportTarget(entry.exports, subpath);
			if (target) return sourceForExport(entry.packageRoot, target);
			if (subpath === "." || !entry.exports) {
				const tail = subpath === "." ? "index" : subpath.slice(2);
				return resolveSourcePath(resolve(entry.sourceRoot, tail));
			}
			return undefined;
		}
	}

	function packageName(file) {
		const normalized = normalizePath(relative(root, file));
		return [...packageRoots].find(([, entry]) => normalized.startsWith(`${normalizePath(relative(root, entry.sourceRoot))}/`))?.[0];
	}

	return { packageRoots, resolveImport, packageName };
}

export function buildValueGraph(roots, resolver, { includeUnresolved = false, includeTypes = false } = {}) {
	const graph = new Map();
	const queue = [...roots];
	while (queue.length) {
		const file = queue.pop();
		if (graph.has(file)) continue;
		const targets = new Set();
		const specifiers = collectValueSpecifiers(file);
		if (includeTypes) specifiers.push(...collectTypeSpecifiers(file));
		for (const specifier of specifiers) {
			const target = resolver.resolveImport(specifier, file);
			if (target) targets.add(target);
			else if (includeUnresolved) targets.add(specifier);
		}
		graph.set(file, targets);
		queue.push(...[...targets].filter((target) => !graph.has(target) && isAbsolute(target)));
	}
	return graph;
}

export function reachableFiles(roots, resolver) {
	return new Set(buildValueGraph(roots, resolver).keys());
}
