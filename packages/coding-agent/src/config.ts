import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { normalizePath } from "./utils/paths.ts";
import { stripBom } from "./utils/text.ts";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

/** Detect the esbuild-bundled Node.js distribution. */
declare const CANDY_BUNDLED_NODE: boolean;
export const isBundledNode = typeof CANDY_BUNDLED_NODE !== "undefined" && CANDY_BUNDLED_NODE;

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js: returns the package root containing package.json
 * - Ignores Bun binary metadata copied into dist/ when the package root is available
 */
export function findNodePackageDir(startDir: string): string {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			const parent = dirname(dir);
			// build:binary places Bun's metadata inside dist/. Node still needs the
			// package root so its dist-relative asset paths do not become dist/dist/.
			if (basename(dir) === "dist" && existsSync(join(parent, "package.json"))) {
				return parent;
			}
			return dir;
		}
		dir = dirname(dir);
	}
	return startDir;
}

export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.CANDY_PACKAGE_DIR;
	if (envDir) {
		return normalizePath(envDir);
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	return findNodePackageDir(__dirname);
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: modes/interactive/theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For source (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "modes", "interactive", "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: presentation/export-html/ next to executable
 * - For Node.js (dist/): dist/presentation/export-html/
 * - For source (src/): src/presentation/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "presentation", "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "presentation", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

// =============================================================================
// App Config (from package.json candyConfig)
// =============================================================================

interface PackageJson {
	name?: string;
	version?: string;
	candyConfig?: {
		name?: string;
		configDir?: string;
	};
}

let pkg: PackageJson = {};
try {
	pkg = JSON.parse(stripBom(readFileSync(getPackageJsonPath(), "utf-8"))) as PackageJson;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

export const PACKAGE_NAME: string = pkg.name || "@candy/coding-agent";
export const APP_NAME: string = pkg.candyConfig?.name || "candy";
export const APP_TITLE: string = APP_NAME;
export const CONFIG_DIR_NAME: string = pkg.candyConfig?.configDir || ".candy";
export const VERSION: string = pkg.version || "0.0.0";

// e.g., CANDY_CODING_AGENT_DIR or TAU_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;

export function expandTildePath(path: string): string {
	return normalizePath(path);
}

// =============================================================================
// User Config Paths (~/.candy/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.candy/agent/) */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
