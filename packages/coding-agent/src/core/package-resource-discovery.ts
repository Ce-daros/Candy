import { existsSync, globSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { toPosixPath } from "../utils/paths.ts";
import { readCandyManifest } from "./candy-manifest.ts";

export interface PackageFilter {
	autoload?: boolean;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export type ResourceType = "extensions" | "skills" | "prompts" | "themes";

export const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts", "themes"];

const FILE_PATTERNS: Record<ResourceType, RegExp> = {
	extensions: /\.(ts|js)$/,
	skills: /\.md$/,
	prompts: /\.md$/,
	themes: /\.json$/,
};

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		const content = readFileSync(ignorePath, "utf-8");
		const patterns = content
			.split(/\r?\n/)
			.map((line) => prefixIgnorePattern(line, prefix))
			.filter((line): line is string => Boolean(line));
		if (patterns.length > 0) {
			ig.add(patterns);
		}
	}
}

export function isPattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-") || s.includes("*") || s.includes("?");
}

export function isOverridePattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

export function hasGlobPattern(s: string): boolean {
	return s.includes("*") || s.includes("?");
}

/** Glob entries discover visible paths; exact entries can target dot paths or symlinked trees. */
export function expandPackageGlob(pattern: string, root: string): string[] {
	return globSync(pattern, { cwd: root })
		.map((match) => resolve(root, match))
		.filter((path) =>
			relative(root, path)
				.split(sep)
				.every((segment) => segment === ".." || !segment.startsWith(".")),
		)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function splitPatterns(entries: string[]): { plain: string[]; patterns: string[] } {
	const plain: string[] = [];
	const patterns: string[] = [];
	for (const entry of entries) {
		if (isPattern(entry)) {
			patterns.push(entry);
		} else {
			plain.push(entry);
		}
	}
	return { plain, patterns };
}

interface ResourceDirectoryEntry {
	name: string;
	path: string;
	isDirectory: boolean;
	isFile: boolean;
}

function readResourceDirectory(dir: string, root: string, ig: IgnoreMatcher): ResourceDirectoryEntry[] {
	if (!existsSync(dir)) return [];
	addIgnoreRules(ig, dir, root);
	const result: ResourceDirectoryEntry[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		let isDirectory = entry.isDirectory();
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				const stats = statSync(path);
				isDirectory = stats.isDirectory();
				isFile = stats.isFile();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
		}
		const relativePath = toPosixPath(relative(root, path));
		if (ig.ignores(isDirectory ? `${relativePath}/` : relativePath)) continue;
		result.push({ name: entry.name, path, isDirectory, isFile });
	}
	return result;
}

function collectFiles(dir: string, filePattern: RegExp, ignoreMatcher?: IgnoreMatcher, rootDir?: string): string[] {
	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	const files: string[] = [];
	for (const entry of readResourceDirectory(dir, root, ig)) {
		if (entry.isDirectory) files.push(...collectFiles(entry.path, filePattern, ig, root));
		else if (entry.isFile && filePattern.test(entry.name)) files.push(entry.path);
	}
	return files;
}

type SkillDiscoveryMode = "candy" | "agents";

function collectSkillEntries(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	const children = readResourceDirectory(dir, root, ig);
	const manifest = children.find((entry) => entry.name === "SKILL.md" && entry.isFile);
	if (manifest) return [manifest.path];
	const entries: string[] = [];
	for (const entry of children) {
		if (
			entry.isFile &&
			entry.name.endsWith(".md") &&
			((mode === "candy" && dir === root) || (mode === "agents" && dir !== root))
		)
			entries.push(entry.path);
		else if (entry.isDirectory) entries.push(...collectSkillEntries(entry.path, mode, ig, root));
	}
	return entries;
}

export function collectAutoSkillEntries(dir: string, mode: SkillDiscoveryMode): string[] {
	return collectSkillEntries(dir, mode);
}

function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

export function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const skillDirs: string[] = [];
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

	let dir = resolvedStartDir;
	while (true) {
		skillDirs.push(join(dir, ".agents", "skills"));
		if (gitRepoRoot && dir === gitRepoRoot) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	return skillDirs;
}

export function collectAutoPromptEntries(dir: string): string[] {
	return readResourceDirectory(dir, dir, ignore())
		.filter((entry) => entry.isFile && entry.name.endsWith(".md"))
		.map((entry) => entry.path);
}

export function collectAutoThemeEntries(dir: string): string[] {
	return readResourceDirectory(dir, dir, ignore())
		.filter((entry) => entry.isFile && entry.name.endsWith(".json"))
		.map((entry) => entry.path);
}

function resolveExtensionEntries(dir: string): string[] | null {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		const manifest = readCandyManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = resolve(dir, extPath);
				if (existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	const indexTs = join(dir, "index.ts");
	const indexJs = join(dir, "index.js");
	if (existsSync(indexTs)) {
		return [indexTs];
	}
	if (existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

export function collectAutoExtensionEntries(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) return rootEntries;
	const entries: string[] = [];
	for (const entry of readResourceDirectory(dir, dir, ignore())) {
		if (entry.isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) entries.push(entry.path);
		else if (entry.isDirectory) {
			const resolved = resolveExtensionEntries(entry.path);
			if (resolved) entries.push(...resolved);
		}
	}
	return entries;
}

/**
 * Collect resource files from a directory based on resource type.
 * Extensions use smart discovery (index.ts in subdirs), others use recursive collection.
 */
export function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
	if (resourceType === "skills") {
		return collectSkillEntries(dir, "candy");
	}
	if (resourceType === "extensions") {
		return collectAutoExtensionEntries(dir);
	}
	return collectFiles(dir, FILE_PATTERNS[resourceType]);
}

function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentName = isSkillFile ? basename(parentDir!) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalizedPattern = toPosixPath(pattern);
		if (
			minimatch(rel, normalizedPattern) ||
			minimatch(name, normalizedPattern) ||
			minimatch(filePathPosix, normalizedPattern)
		) {
			return true;
		}
		if (!isSkillFile) return false;
		return (
			minimatch(parentRel!, normalizedPattern) ||
			minimatch(parentName!, normalizedPattern) ||
			minimatch(parentDirPosix!, normalizedPattern)
		);
	});
}

function normalizeExactPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalized);
}

function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalized = normalizeExactPattern(pattern);
		if (normalized === rel || normalized === filePathPosix) {
			return true;
		}
		if (!isSkillFile) return false;
		return normalized === parentRel || normalized === parentDirPosix;
	});
}

function getOverridePatterns(entries: string[]): string[] {
	return entries.filter((pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));
}

export function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
	const overrides = getOverridePatterns(patterns);
	const excludes = overrides.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	const forceIncludes = overrides.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
	const forceExcludes = overrides.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));

	let enabled = true;
	if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) {
		enabled = false;
	}
	if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
		enabled = true;
	}
	if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
		enabled = false;
	}
	return enabled;
}

/**
 * Apply patterns to paths and return a Set of enabled paths.
 * Pattern types:
 * - Plain patterns: include matching paths
 * - `!pattern`: exclude matching paths
 * - `+path`: force-include exact path (overrides exclusions)
 * - `-path`: force-exclude exact path (overrides force-includes)
 */
export function applyPatterns(allPaths: string[], patterns: string[], baseDir: string): Set<string> {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];

	for (const p of patterns) {
		if (p.startsWith("+")) {
			forceIncludes.push(p.slice(1));
		} else if (p.startsWith("-")) {
			forceExcludes.push(p.slice(1));
		} else if (p.startsWith("!")) {
			excludes.push(p.slice(1));
		} else {
			includes.push(p);
		}
	}

	// Step 1: Apply includes (or all if no includes)
	let result: string[];
	if (includes.length === 0) {
		result = [...allPaths];
	} else {
		result = allPaths.filter((filePath) => matchesAnyPattern(filePath, includes, baseDir));
	}

	// Step 2: Apply excludes
	if (excludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyPattern(filePath, excludes, baseDir));
	}

	// Step 3: Force-include (add back from allPaths, overriding exclusions)
	if (forceIncludes.length > 0) {
		for (const filePath of allPaths) {
			if (!result.includes(filePath) && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
				result.push(filePath);
			}
		}
	}

	// Step 4: Force-exclude (remove even if included or force-included)
	if (forceExcludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyExactPattern(filePath, forceExcludes, baseDir));
	}

	return new Set(result);
}

export function applyAutoloadDisabledPatterns(
	allPaths: string[],
	patterns: string[],
	baseDir: string,
): Map<string, boolean> {
	const result = new Map<string, boolean>();
	for (const pattern of patterns) {
		const target = pattern.slice(
			pattern.startsWith("+") || pattern.startsWith("-") || pattern.startsWith("!") ? 1 : 0,
		);
		const enabled = !pattern.startsWith("-") && !pattern.startsWith("!");
		const exact = pattern.startsWith("+") || pattern.startsWith("-");
		for (const filePath of allPaths) {
			if (
				exact ? matchesAnyExactPattern(filePath, [target], baseDir) : matchesAnyPattern(filePath, [target], baseDir)
			) {
				result.set(filePath, enabled);
			}
		}
	}
	return result;
}
