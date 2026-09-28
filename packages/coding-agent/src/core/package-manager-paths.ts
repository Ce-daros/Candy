import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import type { PackageScope } from "./package-manager-types.ts";

export interface PackageManagerPathsOptions {
	cwd: string;
	agentDir: string;
	isProjectTrusted(): boolean;
}

export function getExtensionTempFolder(agentDir: string): string {
	const tempFolder = join(agentDir, "tmp", "extensions");
	mkdirSync(tempFolder, { recursive: true, mode: 0o700 });
	chmodSync(tempFolder, 0o700);
	return tempFolder;
}

export class PackageManagerPaths {
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly isProjectTrusted: () => boolean;

	constructor(options: PackageManagerPathsOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.isProjectTrusted = options.isProjectTrusted;
	}

	assertTrusted(scope: PackageScope): void {
		if (scope === "project" && !this.isProjectTrusted()) {
			throw new Error("Project is not trusted; refusing to access project package storage");
		}
	}

	getNpmInstallRoot(scope: PackageScope, temporary: boolean): string {
		if (temporary) return this.getTemporaryDir("npm");
		if (scope === "project") {
			this.assertTrusted(scope);
			return join(this.cwd, CONFIG_DIR_NAME, "npm");
		}
		return join(this.agentDir, "npm");
	}

	getManagedNpmInstallPath(name: string, scope: PackageScope): string {
		if (scope === "temporary") return join(this.getTemporaryDir("npm"), "node_modules", name);
		return join(this.getNpmInstallRoot(scope, false), "node_modules", name);
	}

	getGitInstallPath(host: string, repositoryPath: string, ref: string | undefined, scope: PackageScope): string {
		if (scope === "temporary") {
			return this.getTemporaryDir(`git-${host}`, repositoryPath, ref);
		}
		const installRoot = this.getGitInstallRoot(scope);
		if (!installRoot) throw new Error("Missing git install root");
		return this.resolveManagedPath(installRoot, host, repositoryPath);
	}

	getGitInstallRoot(scope: PackageScope): string | undefined {
		if (scope === "temporary") return undefined;
		if (scope === "project") {
			this.assertTrusted(scope);
			return join(this.cwd, CONFIG_DIR_NAME, "git");
		}
		return join(this.agentDir, "git");
	}

	getBaseDir(scope: PackageScope): string {
		if (scope === "project") {
			this.assertTrusted(scope);
			return join(this.cwd, CONFIG_DIR_NAME);
		}
		if (scope === "user") return this.agentDir;
		return this.cwd;
	}

	resolvePath(input: string): string {
		return resolvePath(input, this.cwd, { homeDir: process.env.HOME || homedir(), trim: true });
	}

	resolvePathFromBase(input: string, baseDir: string): string {
		return resolvePath(input, baseDir, { homeDir: process.env.HOME || homedir(), trim: true });
	}

	getHomeDir(): string {
		return process.env.HOME || homedir();
	}

	private getTemporaryDir(prefix: string, suffix?: string, ref?: string): string {
		const root = this.resolveManagedPath(getExtensionTempFolder(this.agentDir), prefix);
		const hash = createHash("sha256")
			.update(`${prefix}-${suffix ?? ""}${ref ? `@${ref}` : ""}`)
			.digest("hex")
			.slice(0, 8);
		return this.resolveManagedPath(root, hash, suffix ?? "");
	}

	private resolveManagedPath(root: string, ...parts: string[]): string {
		const resolvedRoot = resolve(root);
		const resolvedPath = resolve(resolvedRoot, ...parts);
		if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
			throw new Error(`Refusing to use path outside package install root: ${resolvedPath}`);
		}
		return resolvedPath;
	}
}
