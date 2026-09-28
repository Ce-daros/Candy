import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { GitSource } from "../utils/git.ts";
import { stripBom } from "../utils/text.ts";
import type { PackageScope } from "./package-manager-types.ts";

const NETWORK_TIMEOUT_MS = 10000;

type CommandOptions = { cwd?: string };
type CaptureOptions = { cwd?: string; timeoutMs?: number; env?: Record<string, string> };

export interface GitPackageOperationsOptions {
	getInstallPath(source: GitSource, scope: PackageScope): string;
	getInstallRoot(scope: PackageScope): string | undefined;
	ensureGitIgnore(path: string): void;
	getDependencyInstallArgs(): string[];
	runCommand(command: string, args: string[], options?: CommandOptions): Promise<void>;
	runCommandCapture(command: string, args: string[], options?: CaptureOptions): Promise<string>;
	runNpmCommand(args: string[], options?: CommandOptions): Promise<void>;
	withProgress(action: "pull", source: string, message: string, operation: () => Promise<void>): Promise<void>;
}

export class GitPackageOperations {
	private readonly options: GitPackageOperationsOptions;

	constructor(options: GitPackageOperationsOptions) {
		this.options = options;
	}

	async install(source: GitSource, scope: PackageScope): Promise<void> {
		const targetDir = this.options.getInstallPath(source, scope);
		if (existsSync(targetDir)) {
			await this.updateExisting(source, targetDir);
			return;
		}

		const gitRoot = this.options.getInstallRoot(scope);
		if (gitRoot) this.options.ensureGitIgnore(gitRoot);
		mkdirSync(dirname(targetDir), { recursive: true });
		rmSync(this.getUpdateMarkerPath(targetDir), { force: true });

		try {
			await this.options.runCommand("git", ["clone", source.repo, targetDir]);
			if (source.ref) await this.options.runCommand("git", ["checkout", source.ref], { cwd: targetDir });
			if (existsSync(join(targetDir, "package.json"))) {
				await this.options.runNpmCommand(this.options.getDependencyInstallArgs(), { cwd: targetDir });
			}
		} catch (error) {
			rmSync(targetDir, { recursive: true, force: true });
			this.pruneEmptyParents(targetDir, gitRoot);
			throw error;
		}
	}

	async update(source: GitSource, scope: PackageScope): Promise<void> {
		const targetDir = this.options.getInstallPath(source, scope);
		if (!existsSync(targetDir)) {
			await this.install(source, scope);
			return;
		}
		await this.updateExisting(source, targetDir);
	}

	async hasAvailableUpdate(installedPath: string): Promise<boolean> {
		if (this.isOffline()) return false;
		try {
			const localHead = await this.options.runCommandCapture("git", ["rev-parse", "HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const remoteHead = await this.getRemoteHead(installedPath);
			return localHead.trim() !== remoteHead.trim();
		} catch {
			return false;
		}
	}

	async refreshTemporary(source: GitSource, sourceString: string): Promise<void> {
		if (this.isOffline()) return;
		try {
			await this.options.withProgress("pull", sourceString, `Refreshing ${sourceString}...`, async () => {
				await this.update(source, "temporary");
			});
		} catch {
			// Cached temporary checkouts remain usable when the network is unavailable.
		}
	}

	remove(source: GitSource, scope: PackageScope): void {
		const targetDir = this.options.getInstallPath(source, scope);
		rmSync(targetDir, { recursive: true, force: true });
		rmSync(this.getUpdateMarkerPath(targetDir), { force: true });
		this.pruneEmptyParents(targetDir, this.options.getInstallRoot(scope));
	}

	private async updateExisting(source: GitSource, targetDir: string): Promise<void> {
		if (source.ref) {
			await this.ensureRef(targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD");
			return;
		}
		const target = await this.getLocalUpdateTarget(targetDir);
		await this.ensureRef(targetDir, target.fetchArgs, target.ref);
	}

	private async ensureRef(targetDir: string, fetchArgs: string[], ref: string): Promise<void> {
		await this.options.runCommand("git", fetchArgs, { cwd: targetDir });
		const localHead = await this.options.runCommandCapture("git", ["rev-parse", "HEAD"], {
			cwd: targetDir,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const commitRef = `${ref}^{commit}`;
		const targetHead = await this.options.runCommandCapture("git", ["rev-parse", commitRef], {
			cwd: targetDir,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const markerPath = this.getUpdateMarkerPath(targetDir);
		if (localHead.trim() === targetHead.trim()) {
			if (existsSync(markerPath)) await this.cleanAndInstallDependencies(targetDir, markerPath);
			else await this.repairMissingDependencies(targetDir);
			return;
		}

		writeFileSync(markerPath, "", "utf-8");
		await this.options.runCommand("git", ["reset", "--hard", commitRef], { cwd: targetDir });
		await this.cleanAndInstallDependencies(targetDir, markerPath);
	}

	private async cleanAndInstallDependencies(targetDir: string, markerPath: string): Promise<void> {
		try {
			await this.options.runCommand("git", ["clean", "-fdx"], { cwd: targetDir });
		} catch (error) {
			await this.repairMissingDependencies(targetDir).catch(() => {});
			throw error;
		}

		if (existsSync(join(targetDir, "package.json"))) {
			await this.options.runNpmCommand(this.options.getDependencyInstallArgs(), { cwd: targetDir });
		}
		rmSync(markerPath, { force: true });
	}

	private async repairMissingDependencies(targetDir: string): Promise<void> {
		if (!this.hasMissingDependencies(targetDir)) return;
		await this.options.runNpmCommand(this.options.getDependencyInstallArgs(), { cwd: targetDir });
	}

	private hasMissingDependencies(targetDir: string): boolean {
		const packageJsonPath = join(targetDir, "package.json");
		if (!existsSync(packageJsonPath)) return false;
		try {
			const manifest = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as { dependencies?: unknown };
			if (
				!manifest.dependencies ||
				typeof manifest.dependencies !== "object" ||
				Array.isArray(manifest.dependencies)
			) {
				return false;
			}
			const nodeModulesDir = resolve(targetDir, "node_modules");
			return Object.keys(manifest.dependencies).some((name) => {
				const dependencyPath = resolve(nodeModulesDir, name);
				if (!dependencyPath.startsWith(`${nodeModulesDir}${sep}`)) return false;
				return !existsSync(dependencyPath);
			});
		} catch {
			return false;
		}
	}

	private getUpdateMarkerPath(targetDir: string): string {
		return join(dirname(targetDir), `.${basename(targetDir)}.pi-update-incomplete`);
	}

	private async getLocalUpdateTarget(
		installedPath: string,
	): Promise<{ ref: string; head: string; fetchArgs: string[] }> {
		try {
			const upstream = await this.options.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const trimmedUpstream = upstream.trim();
			if (!trimmedUpstream.startsWith("origin/")) throw new Error(`Unsupported upstream remote: ${trimmedUpstream}`);
			const branch = trimmedUpstream.slice("origin/".length);
			if (!branch) throw new Error("Missing upstream branch name");
			const head = await this.options.runCommandCapture("git", ["rev-parse", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			return {
				ref: "@{upstream}",
				head,
				fetchArgs: [
					"fetch",
					"--prune",
					"--no-tags",
					"origin",
					`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
				],
			};
		} catch {
			await this.options
				.runCommand("git", ["remote", "set-head", "origin", "-a"], { cwd: installedPath })
				.catch(() => {});
			const head = await this.options.runCommandCapture("git", ["rev-parse", "origin/HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const originHeadRef = await this.options
				.runCommandCapture("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
					cwd: installedPath,
					timeoutMs: NETWORK_TIMEOUT_MS,
				})
				.catch(() => "");
			const branch = originHeadRef.trim().replace(/^refs\/remotes\/origin\//, "");
			return {
				ref: "origin/HEAD",
				head,
				fetchArgs: branch
					? ["fetch", "--prune", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]
					: ["fetch", "--prune", "--no-tags", "origin", "+HEAD:refs/remotes/origin/HEAD"],
			};
		}
	}

	private async getRemoteHead(installedPath: string): Promise<string> {
		const upstreamRef = await this.getUpstreamRef(installedPath);
		if (upstreamRef) {
			const remoteHead = await this.runRemoteCommand(installedPath, ["ls-remote", "origin", upstreamRef]);
			const match = remoteHead.match(/^([0-9a-f]{40})\s+/m);
			if (match?.[1]) return match[1];
		}
		const remoteHead = await this.runRemoteCommand(installedPath, ["ls-remote", "origin", "HEAD"]);
		const match = remoteHead.match(/^([0-9a-f]{40})\s+HEAD$/m);
		if (!match?.[1]) throw new Error("Failed to determine remote HEAD");
		return match[1];
	}

	private async getUpstreamRef(installedPath: string): Promise<string | undefined> {
		try {
			const upstream = await this.options.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const trimmed = upstream.trim();
			if (!trimmed.startsWith("origin/")) return undefined;
			const branch = trimmed.slice("origin/".length);
			return branch ? `refs/heads/${branch}` : undefined;
		} catch {
			return undefined;
		}
	}

	private runRemoteCommand(installedPath: string, args: string[]): Promise<string> {
		return this.options.runCommandCapture("git", args, {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
			env: { GIT_TERMINAL_PROMPT: "0" },
		});
	}

	private pruneEmptyParents(targetDir: string, installRoot: string | undefined): void {
		if (!installRoot) return;
		const resolvedRoot = resolve(installRoot);
		let current = dirname(targetDir);
		while (current.startsWith(resolvedRoot) && current !== resolvedRoot) {
			if (!existsSync(current)) {
				current = dirname(current);
				continue;
			}
			if (readdirSync(current).length > 0) break;
			try {
				rmSync(current, { recursive: true, force: true });
			} catch {
				break;
			}
			current = dirname(current);
		}
	}

	private isOffline(): boolean {
		const value = process.env.CANDY_OFFLINE;
		return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
	}
}
