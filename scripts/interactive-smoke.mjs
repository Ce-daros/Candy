#!/usr/bin/env node

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { isBuiltin } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { workspaceSourceAliases } from "./lib/workspace-paths.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = join(root, "node_modules", ".cache");
mkdirSync(temporaryRoot, { recursive: true });
const temporary = mkdtempSync(join(temporaryRoot, "candy-interactive-smoke-"));
const isolationBase = process.platform === "win32" ? process.env.PUBLIC : tmpdir();
if (!isolationBase) throw new Error("PUBLIC is required for an isolated Windows smoke run");
const isolation = mkdtempSync(join(isolationBase, "candy-interactive-smoke-"));
function removeSmokeDirectory(directory, parent) {
	const absolute = resolve(directory);
	if (dirname(absolute) !== resolve(parent) || !basename(absolute).startsWith("candy-interactive-smoke-")) {
		throw new Error(`Refusing to remove unexpected smoke directory: ${absolute}`);
	}
	rmSync(absolute, { recursive: true, force: true });
}
const isolatedHome = join(isolation, "home");
const isolatedWorkspace = join(isolation, "workspace");
const isolatedTemp = join(isolation, "temp");
for (const directory of [isolatedHome, isolatedWorkspace, isolatedTemp]) mkdirSync(directory, { recursive: true });
mkdirSync(join(isolatedWorkspace, ".git"));
mkdirSync(join(isolatedTemp, ".git"));
const packageDir = join(root, "packages", "coding-agent");
const aliases = workspaceSourceAliases();

const aliasesPlugin = {
	name: "workspace-source-aliases",
	setup(builder) {
		builder.onResolve({ filter: /^@candy\// }, ({ path }) => {
			const alias = aliases.find(({ find }) => find.test(path));
			if (alias) return { path: path.replace(alias.find, alias.replacement) };
			throw new Error(`Missing smoke alias for ${path}`);
		});
		// Resolve external dependencies beside their source importer before moving the bundle.
		builder.onResolve({ filter: /^[^./\\]/ }, async (args) => {
			if (isAbsolute(args.path) || isBuiltin(args.path) || args.pluginData?.resolvingExternal) return;
			const result = await builder.resolve(args.path, {
				kind: args.kind,
				resolveDir: args.resolveDir,
				pluginData: { resolvingExternal: true },
			});
			if (result.errors.length > 0) return { errors: result.errors };
			return {
				path: args.kind === "require-call" ? result.path : pathToFileURL(result.path).href,
				external: true,
			};
		});
	},
};

try {
	const output = join(temporary, "interactive-smoke.mjs");
	await build({
		entryPoints: [join(packageDir, "test", "fixtures", "interactive-smoke-entry.ts")],
		outfile: output,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22.19",
		plugins: [aliasesPlugin],
		banner: {
			js: 'import { createRequire as __candyCreateRequire } from "node:module"; const require = __candyCreateRequire(import.meta.url);',
		},
		logLevel: "error",
	});
	const childEnv = { ...process.env };
	for (const key of Object.keys(childEnv)) {
		if (/(_API_KEY|_TOKEN|_SECRET|_AUTH|_CREDENTIAL|^OPENAI_|^ANTHROPIC_|^OPENROUTER_)/i.test(key)) {
			delete childEnv[key];
		}
	}
	const child = spawn(process.execPath, [output, ...process.argv.slice(2)], {
		stdio: "inherit",
		cwd: isolatedWorkspace,
		env: {
			...childEnv,
			HOME: isolatedHome,
			USERPROFILE: isolatedHome,
			...(process.platform === "win32"
				? { HOMEDRIVE: isolatedHome.slice(0, 2), HOMEPATH: isolatedHome.slice(2) }
				: {}),
			APPDATA: join(isolatedHome, "AppData", "Roaming"),
			LOCALAPPDATA: join(isolatedHome, "AppData", "Local"),
			XDG_CONFIG_HOME: join(isolatedHome, ".config"),
			XDG_DATA_HOME: join(isolatedHome, ".local", "share"),
			XDG_CACHE_HOME: join(isolatedHome, ".cache"),
			TMP: isolatedTemp,
			TEMP: isolatedTemp,
			TMPDIR: isolatedTemp,
			CANDY_PACKAGE_DIR: packageDir,
			CANDY_CODING_AGENT_DIR: join(isolation, "agent"),
			CANDY_CODING_AGENT_SESSION_DIR: join(isolation, "sessions"),
			CANDY_OFFLINE: "1",
			CANDY_SKIP_VERSION_CHECK: "1",
		},
	});
	const exitCode = await new Promise((resolveExit, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolveExit(signal ? 1 : (code ?? 1)));
	});
	process.exitCode = exitCode;
} finally {
	removeSmokeDirectory(temporary, temporaryRoot);
	removeSmokeDirectory(isolation, isolationBase);
}
