import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { transformSync } from "esbuild";
import { walkFiles } from "./files.mjs";
import { repositoryRoot, workspacePackages } from "./workspace-paths.mjs";

const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts"];

export function normalizePath(path) {
	return path.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
}

function collectTypeScriptFiles(directory) {
	return [...walkFiles(directory)].filter(
		(file) => SOURCE_EXTENSIONS.includes(extname(file)) && !file.endsWith(".d.ts"),
	);
}

function collectValueSpecifiers(file, source) {
	const { code } = transformSync(source, {
		loader: SOURCE_EXTENSIONS.includes(extname(file)) ? "ts" : extname(file).slice(1),
		sourcefile: file,
		format: "esm",
		legalComments: "none",
	});
	const specifiers = [];
	const staticImports = /(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']/g;
	const dynamicImports = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
	for (const match of code.matchAll(staticImports)) specifiers.push(match[1]);
	for (const match of code.matchAll(dynamicImports)) specifiers.push(match[1]);
	const relativeUrls = /\bnew\s+URL\s*\(([^;]*?),\s*import\s*\.\s*meta\s*\.\s*url\s*\)/g;
	for (const url of code.matchAll(relativeUrls)) {
		for (const match of url[1].matchAll(/["'](\.\.?\/[^"']+\.(?:ts|js))["']/g)) specifiers.push(match[1]);
	}
	return specifiers;
}

function collectTypeSpecifiers(source) {
	const specifiers = [];
	const declarations = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^'";]*?\sfrom\s*)["']([^"']+)["']/g;
	for (const match of source.matchAll(declarations)) {
		if (match[2] || /\btype\s+[A-Za-z_$]/.test(match[3])) specifiers.push(match[4]);
	}
	const importTypes = /\b(?:typeof\s+)?import\s*\(\s*["']([^"']+)["']\s*\)\s*\.[A-Za-z_$]/g;
	for (const match of source.matchAll(importTypes)) specifiers.push(match[1]);
	return specifiers;
}

export function createSourceScanner(resolver, sourceRoots = []) {
	const files = sourceRoots.flatMap(collectTypeScriptFiles);
	const edges = new Map();
	function dependencies(file) {
		if (!edges.has(file)) {
			const source = readFileSync(file, "utf8");
			const values = collectValueSpecifiers(file, source);
			const types = collectTypeSpecifiers(source);
			const resolved = new Map(
				[...new Set([...values, ...types])].map((specifier) => [
					specifier,
					resolver.resolveImport(specifier, file),
				]),
			);
			const targets = (specifiers) =>
				new Set(specifiers.map((specifier) => resolved.get(specifier)).filter((target) => target !== undefined));
			edges.set(file, { values: targets(values), types: targets(types) });
		}
		return edges.get(file);
	}
	return { files, dependencies };
}

export function packageExportTarget(value) {
	return typeof value === "string" ? value : (value.import ?? value.default ?? value.require);
}

function sourceForExport(packageRoot, target) {
	if (typeof target !== "string") return undefined;
	const sourceRelative = target
		.replace(/^\.\/dist\//, "")
		.replace(/\.d?\.ts$/, ".ts")
		.replace(/\.js$/, ".ts");
	const sourcePath = resolve(packageRoot, "src", sourceRelative);
	return existsSync(sourcePath) && statSync(sourcePath).isFile() ? sourcePath : undefined;
}

function exportTarget(exports, subpath) {
	const exact = exports?.[subpath];
	if (exact) return packageExportTarget(exact);
	for (const [pattern, value] of Object.entries(exports ?? {})) {
		if (!pattern.includes("*")) continue;
		const [prefix, suffix] = pattern.split("*");
		if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
		const capture = subpath.slice(prefix.length, subpath.length - suffix.length);
		const target = packageExportTarget(value);
		return target?.replaceAll("*", capture);
	}
	return undefined;
}

export function createWorkspaceResolver(root = repositoryRoot) {
	const packageRoots = new Map();
	for (const [name, sourceRoot] of workspacePackages(root)) {
		const packageRoot = resolve(root, dirname(sourceRoot));
		const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
		packageRoots.set(name, {
			packageRoot,
			sourceRoot: resolve(root, sourceRoot),
			exports: manifest.exports,
			manifest,
		});
	}

	function resolveSourcePath(basePath) {
		const normalizedBase = basePath.replace(/\.js$/, ".ts");
		for (const candidate of [
			normalizedBase,
			...SOURCE_EXTENSIONS.map((extension) => `${normalizedBase}${extension}`),
			...SOURCE_EXTENSIONS.map((extension) => resolve(normalizedBase, `index${extension}`)),
		]) {
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
		return [...packageRoots].find(([, entry]) =>
			normalized.startsWith(`${normalizePath(relative(root, entry.sourceRoot))}/`),
		)?.[0];
	}

	return { packageRoots, resolveImport, packageName };
}

export function buildValueGraph(
	roots,
	resolver,
	{ includeTypes = false, scanner = createSourceScanner(resolver) } = {},
) {
	const graph = new Map();
	const queue = [...roots];
	while (queue.length) {
		const file = queue.pop();
		if (graph.has(file)) continue;
		const edges = scanner.dependencies(file);
		const targets = includeTypes ? new Set([...edges.values, ...edges.types]) : edges.values;
		graph.set(file, targets);
		queue.push(...[...targets].filter((target) => !graph.has(target)));
	}
	return graph;
}

export function reachableFiles(roots, resolver, scanner) {
	return new Set(buildValueGraph(roots, resolver, { scanner }).keys());
}
