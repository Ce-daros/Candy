import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

function getEnv(): NodeJS.ProcessEnv {
	if (process.platform !== "linux" || Object.keys(process.env).length > 0) {
		return process.env;
	}
	try {
		const data = readFileSync("/proc/self/environ", "utf-8");
		const env: NodeJS.ProcessEnv = {};
		for (const entry of data.split("\0")) {
			const idx = entry.indexOf("=");
			if (idx > 0) {
				env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
		return env;
	} catch {
		return process.env;
	}
}

import { basename, dirname, join, relative, resolve } from "node:path";
import type { Readable } from "node:stream";
import { gt, maxSatisfying, rcompare, satisfies } from "semver";
import { CONFIG_DIR_NAME } from "../config.ts";
import { spawnProcess, spawnProcessSync } from "../utils/child-process.ts";
import type { GitSource } from "../utils/git.ts";
import { canonicalizePath, markPathIgnoredByCloudSync, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { type CandyManifest, readCandyManifest } from "./candy-manifest.ts";
import { isStdoutTakenOver } from "./output-guard.ts";
import { GitPackageOperations } from "./package-manager-git.ts";
import { NpmPackageOperations } from "./package-manager-npm.ts";
import { PackageManagerPaths } from "./package-manager-paths.ts";
import type { PackageScope } from "./package-manager-types.ts";
import {
	applyAutoloadDisabledPatterns,
	applyPatterns,
	collectAncestorAgentsSkillDirs,
	collectAutoExtensionEntries,
	collectAutoPromptEntries,
	collectAutoSkillEntries,
	collectAutoThemeEntries,
	collectResourceFiles,
	expandPackageGlob,
	hasGlobPattern,
	isEnabledByOverrides,
	isOverridePattern,
	type PackageFilter,
	RESOURCE_TYPES,
	type ResourceType,
	splitPatterns,
} from "./package-resource-discovery.ts";
import { type LocalSource, type NpmSource, type ParsedSource, parsePackageSource } from "./package-source.ts";
import { packageSourceIdentity } from "./package-source-identity.ts";
import type { PackageSource, SettingsManager } from "./settings-manager.ts";

const NETWORK_TIMEOUT_MS = 10000;
const UPDATE_CHECK_CONCURRENCY = 4;
const GIT_UPDATE_CONCURRENCY = 4;

function isOfflineModeEnabled(): boolean {
	const value = process.env.CANDY_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export interface PathMetadata {
	source: string;
	scope: SourceScope;
	origin: "package" | "top-level";
	baseDir?: string;
	packageRoot?: string;
}

export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}

export interface ResolvedPaths {
	extensions: ResolvedResource[];
	skills: ResolvedResource[];
	prompts: ResolvedResource[];
	themes: ResolvedResource[];
}

export type MissingSourceAction = "install" | "skip" | "error";

export interface ProgressEvent {
	type: "start" | "progress" | "complete" | "error";
	action: "install" | "remove" | "update" | "clone" | "pull";
	source: string;
	message?: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

export interface PackageUpdate {
	source: string;
	displayName: string;
	type: "npm" | "git";
	scope: Exclude<SourceScope, "temporary">;
}

export interface ConfiguredPackage {
	source: string;
	scope: "user" | "project";
	filtered: boolean;
	installedPath?: string;
}

export interface PackageManager {
	resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
	install(source: string, options?: { local?: boolean }): Promise<void>;
	installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
	remove(source: string, options?: { local?: boolean }): Promise<void>;
	removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
	update(source?: string): Promise<void>;
	listConfiguredPackages(): ConfiguredPackage[];
	resolveExtensionSources(
		sources: string[],
		options?: { local?: boolean; temporary?: boolean },
	): Promise<ResolvedPaths>;
	addSourceToSettings(source: string, options?: { local?: boolean }): boolean;
	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean;
	setProgressCallback(callback: ProgressCallback | undefined): void;
	getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
}

interface PackageManagerOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
}

type SourceScope = PackageScope;

type InstalledSourceScope = Exclude<SourceScope, "temporary">;

interface ConfiguredUpdateSource {
	source: string;
	scope: InstalledSourceScope;
}

interface NpmUpdateTarget extends ConfiguredUpdateSource {
	parsed: NpmSource;
}

interface GitUpdateTarget extends ConfiguredUpdateSource {
	parsed: GitSource;
}

interface ResourceAccumulator {
	extensions: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	skills: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	prompts: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	themes: Map<string, { metadata: PathMetadata; enabled: boolean }>;
}

/**
 * Compute a numeric precedence rank for a resource based on its metadata.
 * Lower rank = higher precedence. Used to sort resolved resources so that
 * name-collision resolution ("first wins") produces the correct outcome.
 *
 * Precedence (highest to lowest):
 *   0  project + settings entry (source: "local", scope: "project")
 *   1  project + auto-discovered (source: "auto", scope: "project")
 *   2  user + settings entry (source: "local", scope: "user")
 *   3  user + auto-discovered (source: "auto", scope: "user")
 *   4  package resource (origin: "package")
 */
function resourcePrecedenceRank(m: PathMetadata): number {
	if (m.origin === "package") return 4;
	const scopeBase = m.scope === "project" ? 0 : 2;
	return scopeBase + (m.source === "local" ? 0 : 1);
}

export class DefaultPackageManager implements PackageManager {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private globalNpmRoot: string | undefined;
	private globalNpmRootCommandKey: string | undefined;
	private progressCallback: ProgressCallback | undefined;
	private readonly npmOperations: NpmPackageOperations;
	private readonly gitOperations: GitPackageOperations;
	private readonly paths: PackageManagerPaths;

	constructor(options: PackageManagerOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager;
		this.paths = new PackageManagerPaths({
			cwd: this.cwd,
			agentDir: this.agentDir,
			isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
		});
		this.npmOperations = new NpmPackageOperations({
			getInstallRoot: (scope, temporary) => this.paths.getNpmInstallRoot(scope, temporary),
			ensureProject: (installRoot) => this.ensureNpmProject(installRoot),
			getPackageManagerName: () => this.getPackageManagerName(),
			runNpmCommand: (args, commandOptions) => this.runNpmCommand(args, commandOptions),
		});
		this.gitOperations = new GitPackageOperations({
			getInstallPath: (source, scope) => this.paths.getGitInstallPath(source.host, source.path, source.ref, scope),
			getInstallRoot: (scope) => this.paths.getGitInstallRoot(scope),
			ensureGitIgnore: (path) => this.ensureGitIgnore(path),
			getDependencyInstallArgs: () => this.npmOperations.getGitDependencyInstallArgs(),
			runCommand: (command, args, commandOptions) =>
				commandOptions ? this.runCommand(command, args, commandOptions) : this.runCommand(command, args),
			runCommandCapture: (command, args, commandOptions) => this.runCommandCapture(command, args, commandOptions),
			runNpmCommand: (args, commandOptions) => this.runNpmCommand(args, commandOptions),
			withProgress: (action, source, message, operation) => this.withProgress(action, source, message, operation),
		});
	}

	setProgressCallback(callback: ProgressCallback | undefined): void {
		this.progressCallback = callback;
	}

	addSourceToSettings(source: string, options?: { local?: boolean }): boolean {
		const scope: SourceScope = options?.local ? "project" : "user";
		const currentSettings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const currentPackages = currentSettings.packages ?? [];
		const normalizedSource = this.normalizePackageSourceForSettings(source, scope);
		const matchIndex = currentPackages.findIndex((existing) => this.packageSourcesMatch(existing, source, scope));
		if (matchIndex !== -1) {
			const existing = currentPackages[matchIndex];
			if (this.getPackageSourceString(existing) === normalizedSource) {
				return false;
			}
			const nextPackages = [...currentPackages];
			nextPackages[matchIndex] =
				typeof existing === "string" ? normalizedSource : { ...existing, source: normalizedSource };
			if (scope === "project") {
				this.settingsManager.setProjectPackages(nextPackages);
			} else {
				this.settingsManager.setPackages(nextPackages);
			}
			return true;
		}
		const nextPackages = [...currentPackages, normalizedSource];
		if (scope === "project") {
			this.settingsManager.setProjectPackages(nextPackages);
		} else {
			this.settingsManager.setPackages(nextPackages);
		}
		return true;
	}

	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean {
		const scope: SourceScope = options?.local ? "project" : "user";
		const currentSettings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const currentPackages = currentSettings.packages ?? [];
		const nextPackages = currentPackages.filter((existing) => !this.packageSourcesMatch(existing, source, scope));
		const changed = nextPackages.length !== currentPackages.length;
		if (!changed) {
			return false;
		}
		if (scope === "project") {
			this.settingsManager.setProjectPackages(nextPackages);
		} else {
			this.settingsManager.setPackages(nextPackages);
		}
		return true;
	}

	getInstalledPath(source: string, scope: "user" | "project"): string | undefined {
		const parsed = parsePackageSource(source);
		if (parsed.type === "npm") {
			const path = this.getNpmInstallPath(parsed, scope);
			return existsSync(path) ? path : undefined;
		}
		if (parsed.type === "git") {
			const path = this.paths.getGitInstallPath(parsed.host, parsed.path, parsed.ref, scope);
			return existsSync(path) ? path : undefined;
		}
		if (parsed.type === "local") {
			const baseDir = this.paths.getBaseDir(scope);
			const path = this.paths.resolvePathFromBase(parsed.path, baseDir);
			return existsSync(path) ? path : undefined;
		}
		return undefined;
	}

	private emitProgress(event: ProgressEvent): void {
		this.progressCallback?.(event);
	}

	private async withProgress(
		action: ProgressEvent["action"],
		source: string,
		message: string,
		operation: () => Promise<void>,
	): Promise<void> {
		this.emitProgress({ type: "start", action, source, message });
		try {
			await operation();
			this.emitProgress({ type: "complete", action, source });
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.emitProgress({ type: "error", action, source, message: errorMessage });
			throw error;
		}
	}

	async resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths> {
		const accumulator = this.createAccumulator();
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();

		// Collect all packages with scope (project first so cwd resources win collisions)
		const allPackages: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		for (const pkg of projectSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "project" });
		}
		for (const pkg of globalSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "user" });
		}

		// Dedupe: project scope wins over global for same package identity
		const packageSources = this.dedupePackages(allPackages);
		await this.resolvePackageSources(packageSources, accumulator, onMissing);

		const globalBaseDir = this.agentDir;
		const projectBaseDir = join(this.cwd, CONFIG_DIR_NAME);

		for (const resourceType of RESOURCE_TYPES) {
			const target = this.getTargetMap(accumulator, resourceType);
			const globalEntries = (globalSettings[resourceType] ?? []) as string[];
			const projectEntries = (projectSettings[resourceType] ?? []) as string[];
			this.resolveLocalEntries(
				projectEntries,
				resourceType,
				target,
				{
					source: "local",
					scope: "project",
					origin: "top-level",
				},
				projectBaseDir,
			);
			this.resolveLocalEntries(
				globalEntries,
				resourceType,
				target,
				{
					source: "local",
					scope: "user",
					origin: "top-level",
				},
				globalBaseDir,
			);
		}

		this.addAutoDiscoveredResources(accumulator, globalSettings, projectSettings, globalBaseDir, projectBaseDir);

		return this.toResolvedPaths(accumulator);
	}

	async resolveExtensionSources(
		sources: string[],
		options?: { local?: boolean; temporary?: boolean },
	): Promise<ResolvedPaths> {
		const accumulator = this.createAccumulator();
		const scope: SourceScope = options?.temporary ? "temporary" : options?.local ? "project" : "user";
		const packageSources = sources.map((source) => ({ pkg: source as PackageSource, scope }));
		await this.resolvePackageSources(packageSources, accumulator);
		return this.toResolvedPaths(accumulator);
	}

	listConfiguredPackages(): ConfiguredPackage[] {
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const configuredPackages: ConfiguredPackage[] = [];

		for (const pkg of globalSettings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			configuredPackages.push({
				source,
				scope: "user",
				filtered: typeof pkg === "object",
				installedPath: this.getInstalledPath(source, "user"),
			});
		}

		for (const pkg of projectSettings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			configuredPackages.push({
				source,
				scope: "project",
				filtered: typeof pkg === "object",
				installedPath: this.getInstalledPath(source, "project"),
			});
		}

		return configuredPackages;
	}

	async install(source: string, options?: { local?: boolean }): Promise<void> {
		const parsed = parsePackageSource(source);
		const scope: SourceScope = options?.local ? "project" : "user";
		this.paths.assertTrusted(scope);
		await this.withProgress("install", source, `Installing ${source}...`, async () => {
			if (parsed.type === "npm") {
				await this.npmOperations.install(parsed, scope, false);
				return;
			}
			if (parsed.type === "git") {
				await this.gitOperations.install(parsed, scope);
				return;
			}
			if (parsed.type === "local") {
				const resolved = this.paths.resolvePath(parsed.path);
				if (!existsSync(resolved)) {
					throw new Error(`Path does not exist: ${resolved}`);
				}
				return;
			}
			throw new Error(`Unsupported install source: ${source}`);
		});
	}

	async installAndPersist(source: string, options?: { local?: boolean }): Promise<void> {
		await this.install(source, options);
		this.addSourceToSettings(source, options);
	}

	async remove(source: string, options?: { local?: boolean }): Promise<void> {
		const parsed = parsePackageSource(source);
		const scope: SourceScope = options?.local ? "project" : "user";
		this.paths.assertTrusted(scope);
		await this.withProgress("remove", source, `Removing ${source}...`, async () => {
			if (parsed.type === "npm") {
				await this.npmOperations.uninstall(parsed, scope);
				return;
			}
			if (parsed.type === "git") {
				this.gitOperations.remove(parsed, scope);
				return;
			}
			if (parsed.type === "local") {
				return;
			}
			throw new Error(`Unsupported remove source: ${source}`);
		});
	}

	async removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean> {
		await this.remove(source, options);
		return this.removeSourceFromSettings(source, options);
	}

	async update(source?: string): Promise<void> {
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const identity = source ? this.getPackageIdentity(source) : undefined;
		let matched = false;
		const updateSources: ConfiguredUpdateSource[] = [];

		for (const pkg of globalSettings.packages ?? []) {
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			if (identity && this.getPackageIdentity(sourceStr, "user") !== identity) continue;
			matched = true;
			updateSources.push({ source: sourceStr, scope: "user" });
		}
		for (const pkg of projectSettings.packages ?? []) {
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			if (identity && this.getPackageIdentity(sourceStr, "project") !== identity) continue;
			matched = true;
			updateSources.push({ source: sourceStr, scope: "project" });
		}

		if (source && !matched) {
			throw new Error(
				this.buildNoMatchingPackageMessage(source, [
					...(globalSettings.packages ?? []),
					...(projectSettings.packages ?? []),
				]),
			);
		}

		await this.updateConfiguredSources(updateSources);
	}

	private async updateConfiguredSources(sources: ConfiguredUpdateSource[]): Promise<void> {
		if (isOfflineModeEnabled() || sources.length === 0) {
			return;
		}

		const npmCandidates: NpmUpdateTarget[] = [];
		const gitCandidates: GitUpdateTarget[] = [];

		for (const entry of sources) {
			const parsed = parsePackageSource(entry.source);
			// Pinned npm versions are fixed. Pinned git refs are configured checkout targets,
			// so include them to reconcile an existing clone when the configured ref changes.
			if (parsed.type === "npm") {
				if (!parsed.pinned) {
					npmCandidates.push({ ...entry, parsed });
				}
			} else if (parsed.type === "git") {
				gitCandidates.push({ ...entry, parsed });
			}
		}

		const npmCheckTasks = npmCandidates.map((entry) => async () => ({
			entry,
			shouldUpdate: await this.shouldUpdateNpmSource(entry.parsed, entry.scope),
		}));
		const npmCheckResults = await this.runWithConcurrency(npmCheckTasks, UPDATE_CHECK_CONCURRENCY);
		const userNpmUpdates: NpmUpdateTarget[] = [];
		const projectNpmUpdates: NpmUpdateTarget[] = [];
		for (const result of npmCheckResults) {
			if (!result.shouldUpdate) {
				continue;
			}
			if (result.entry.scope === "user") {
				userNpmUpdates.push(result.entry);
			} else {
				projectNpmUpdates.push(result.entry);
			}
		}

		const tasks: Promise<void>[] = [];
		if (userNpmUpdates.length > 0) {
			tasks.push(this.updateNpmBatch(userNpmUpdates, "user"));
		}
		if (projectNpmUpdates.length > 0) {
			tasks.push(this.updateNpmBatch(projectNpmUpdates, "project"));
		}
		if (gitCandidates.length > 0) {
			const gitTasks = gitCandidates.map(
				(entry) => async () =>
					this.withProgress("update", entry.source, `Updating ${entry.source}...`, async () => {
						await this.gitOperations.update(entry.parsed, entry.scope);
					}),
			);
			tasks.push(this.runWithConcurrency(gitTasks, GIT_UPDATE_CONCURRENCY).then(() => {}));
		}

		await Promise.all(tasks);
	}

	private async shouldUpdateNpmSource(source: NpmSource, scope: InstalledSourceScope): Promise<boolean> {
		const installedPath = this.paths.getManagedNpmInstallPath(source.name, scope);
		const installedVersion = existsSync(installedPath) ? this.getInstalledNpmVersion(installedPath) : undefined;
		if (!installedVersion) {
			return true;
		}

		try {
			const targetVersion = await this.getLatestNpmVersion(source.version ? source.spec : source.name, source.range);
			return gt(targetVersion, installedVersion);
		} catch {
			// Preserve existing update behavior when version lookup fails.
			return true;
		}
	}

	private async updateNpmBatch(sources: NpmUpdateTarget[], scope: InstalledSourceScope): Promise<void> {
		if (sources.length === 0) {
			return;
		}

		const sourceLabel = sources.length === 1 ? sources[0].source : `${scope} npm packages`;
		const message = sources.length === 1 ? `Updating ${sources[0].source}...` : `Updating ${scope} npm packages...`;
		const specs = sources.map((entry) => (entry.parsed.version ? entry.parsed.spec : `${entry.parsed.name}@latest`));

		await this.withProgress("update", sourceLabel, message, async () => {
			await this.npmOperations.installBatch(specs, scope);
		});
	}

	async checkForAvailableUpdates(): Promise<PackageUpdate[]> {
		if (isOfflineModeEnabled()) {
			return [];
		}

		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const allPackages: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		for (const pkg of projectSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "project" });
		}
		for (const pkg of globalSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "user" });
		}

		const packageSources = this.dedupePackages(allPackages);
		const checks = packageSources
			.filter(
				(entry): entry is { pkg: PackageSource; scope: Exclude<SourceScope, "temporary"> } =>
					entry.scope !== "temporary",
			)
			.map((entry) => async (): Promise<PackageUpdate | undefined> => {
				const source = typeof entry.pkg === "string" ? entry.pkg : entry.pkg.source;
				const parsed = parsePackageSource(source);
				if (parsed.type === "local" || parsed.pinned) {
					return undefined;
				}

				if (parsed.type === "npm") {
					const installedPath = this.getNpmInstallPath(parsed, entry.scope);
					if (!existsSync(installedPath)) {
						return undefined;
					}
					const hasUpdate = await this.npmHasAvailableUpdate(parsed, installedPath);
					if (!hasUpdate) {
						return undefined;
					}
					return {
						source,
						displayName: parsed.name,
						type: "npm",
						scope: entry.scope,
					};
				}

				const installedPath = this.paths.getGitInstallPath(parsed.host, parsed.path, parsed.ref, entry.scope);
				if (!existsSync(installedPath)) {
					return undefined;
				}
				const hasUpdate = await this.gitOperations.hasAvailableUpdate(installedPath);
				if (!hasUpdate) {
					return undefined;
				}
				return {
					source,
					displayName: `${parsed.host}/${parsed.path}`,
					type: "git",
					scope: entry.scope,
				};
			});

		const results = await this.runWithConcurrency(checks, UPDATE_CHECK_CONCURRENCY);
		return results.filter((result): result is PackageUpdate => result !== undefined);
	}

	private async resolvePackageSources(
		sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
		accumulator: ResourceAccumulator,
		onMissing?: (source: string) => Promise<MissingSourceAction>,
	): Promise<void> {
		for (const { pkg, scope } of sources) {
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			const filter = typeof pkg === "object" ? pkg : undefined;
			const deltaBase = this.findAutoloadDeltaBase(pkg, scope, sources);
			const resolvedSource = deltaBase?.source ?? sourceStr;
			const resolvedScope = deltaBase?.scope ?? scope;
			const parsed = parsePackageSource(resolvedSource);
			const metadata: PathMetadata = { source: sourceStr, scope, origin: "package" };

			if (parsed.type === "local") {
				const baseDir = this.paths.getBaseDir(resolvedScope);
				this.resolveLocalExtensionSource(parsed, accumulator, filter, metadata, baseDir);
				continue;
			}

			const installMissing = async (): Promise<boolean> => {
				if (isOfflineModeEnabled()) return false;
				if (!onMissing) {
					await this.installParsedSource(parsed, resolvedScope);
					return true;
				}
				const action = await onMissing(resolvedSource);
				if (action === "skip") return false;
				if (action === "error") throw new Error(`Missing source: ${resolvedSource}`);
				await this.installParsedSource(parsed, resolvedScope);
				return true;
			};

			if (parsed.type === "npm") {
				let installedPath = this.getNpmInstallPath(parsed, resolvedScope);
				const needsInstall =
					!existsSync(installedPath) || !(await this.installedNpmMatchesConfiguredVersion(parsed, installedPath));
				if (needsInstall) {
					const installed = await installMissing();
					if (!installed) continue;
					installedPath = this.getNpmInstallPath(parsed, resolvedScope);
				}
				metadata.baseDir = installedPath;
				metadata.packageRoot = installedPath;
				this.collectPackageResources(installedPath, accumulator, filter, metadata);
				continue;
			}

			if (parsed.type === "git") {
				const installedPath = this.paths.getGitInstallPath(parsed.host, parsed.path, parsed.ref, resolvedScope);
				if (!existsSync(installedPath)) {
					const installed = await installMissing();
					if (!installed) continue;
				} else if (resolvedScope === "temporary" && !parsed.pinned && !isOfflineModeEnabled()) {
					await this.gitOperations.refreshTemporary(parsed, resolvedSource);
				}
				metadata.baseDir = installedPath;
				metadata.packageRoot = installedPath;
				this.collectPackageResources(installedPath, accumulator, filter, metadata);
			}
		}
	}

	private findAutoloadDeltaBase(
		pkg: PackageSource,
		scope: SourceScope,
		sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
	): { source: string; scope: SourceScope } | undefined {
		if (scope !== "project" || typeof pkg !== "object" || pkg.autoload !== false) return undefined;
		const identity = this.getPackageIdentity(pkg.source, scope);
		const userEntry = sources.find(
			(entry) =>
				entry.scope === "user" &&
				this.getPackageIdentity(this.getPackageSourceString(entry.pkg), "user") === identity,
		);
		return userEntry ? { source: this.getPackageSourceString(userEntry.pkg), scope: "user" } : undefined;
	}

	private resolveLocalExtensionSource(
		source: LocalSource,
		accumulator: ResourceAccumulator,
		filter: PackageFilter | undefined,
		metadata: PathMetadata,
		baseDir: string,
	): void {
		const resolved = this.paths.resolvePathFromBase(source.path, baseDir);
		if (!existsSync(resolved)) {
			return;
		}

		try {
			const stats = statSync(resolved);
			if (stats.isFile()) {
				metadata.baseDir = dirname(resolved);
				this.addResource(accumulator.extensions, resolved, metadata, true);
				return;
			}
			if (stats.isDirectory()) {
				metadata.baseDir = resolved;
				metadata.packageRoot = resolved;
				const resources = this.collectPackageResources(resolved, accumulator, filter, metadata);
				if (!resources) {
					this.addResource(accumulator.extensions, resolved, metadata, true);
				}
			}
		} catch {
			return;
		}
	}

	private async installParsedSource(parsed: ParsedSource, scope: SourceScope): Promise<void> {
		if (parsed.type === "npm") {
			await this.npmOperations.install(parsed, scope, scope === "temporary");
			return;
		}
		if (parsed.type === "git") {
			await this.gitOperations.install(parsed, scope);
			return;
		}
	}

	private getPackageSourceString(pkg: PackageSource): string {
		return typeof pkg === "string" ? pkg : pkg.source;
	}

	private getSourceMatchKeyForInput(source: string): string {
		return packageSourceIdentity(source, (path) => this.paths.resolvePath(path));
	}

	private getSourceMatchKeyForSettings(source: string, scope: SourceScope): string {
		const baseDir = this.paths.getBaseDir(scope);
		return packageSourceIdentity(source, (path) => this.paths.resolvePathFromBase(path, baseDir));
	}

	private buildNoMatchingPackageMessage(source: string, configuredPackages: PackageSource[]): string {
		const suggestion = this.findSuggestedConfiguredSource(source, configuredPackages);
		if (!suggestion) {
			return `No matching package found for ${source}`;
		}
		return `No matching package found for ${source}. Did you mean ${suggestion}?`;
	}

	private findSuggestedConfiguredSource(source: string, configuredPackages: PackageSource[]): string | undefined {
		const trimmedSource = source.trim();
		const suggestions = new Set<string>();

		for (const pkg of configuredPackages) {
			const sourceStr = this.getPackageSourceString(pkg);
			const parsed = parsePackageSource(sourceStr);
			if (parsed.type === "npm") {
				if (trimmedSource === parsed.name || trimmedSource === parsed.spec) {
					suggestions.add(sourceStr);
				}
				continue;
			}
			if (parsed.type === "git") {
				const shorthand = `${parsed.host}/${parsed.path}`;
				const shorthandWithRef = parsed.ref ? `${shorthand}@${parsed.ref}` : undefined;
				if (trimmedSource === shorthand || (shorthandWithRef && trimmedSource === shorthandWithRef)) {
					suggestions.add(sourceStr);
				}
			}
		}

		return suggestions.values().next().value;
	}

	private packageSourcesMatch(existing: PackageSource, inputSource: string, scope: SourceScope): boolean {
		const left = this.getSourceMatchKeyForSettings(this.getPackageSourceString(existing), scope);
		const right = this.getSourceMatchKeyForInput(inputSource);
		return left === right;
	}

	private normalizePackageSourceForSettings(source: string, scope: SourceScope): string {
		const parsed = parsePackageSource(source);
		if (parsed.type !== "local") {
			return source;
		}
		const baseDir = this.paths.getBaseDir(scope);
		const resolved = this.paths.resolvePath(parsed.path);
		const rel = relative(baseDir, resolved);
		return rel || ".";
	}

	private async installedNpmMatchesConfiguredVersion(source: NpmSource, installedPath: string): Promise<boolean> {
		const installedVersion = this.getInstalledNpmVersion(installedPath);
		if (!installedVersion) {
			return false;
		}
		return source.range ? satisfies(installedVersion, source.range) : true;
	}

	private async npmHasAvailableUpdate(source: NpmSource, installedPath: string): Promise<boolean> {
		if (isOfflineModeEnabled()) {
			return false;
		}

		const installedVersion = this.getInstalledNpmVersion(installedPath);
		if (!installedVersion) {
			return false;
		}

		try {
			const targetVersion = await this.getLatestNpmVersion(source.version ? source.spec : source.name, source.range);
			return gt(targetVersion, installedVersion);
		} catch {
			return false;
		}
	}

	private getInstalledNpmVersion(installedPath: string): string | undefined {
		const packageJsonPath = join(installedPath, "package.json");
		if (!existsSync(packageJsonPath)) return undefined;
		try {
			const content = readFileSync(packageJsonPath, "utf-8");
			const pkg = JSON.parse(stripBom(content)) as { version?: string };
			return pkg.version;
		} catch {
			return undefined;
		}
	}

	private async getLatestNpmVersion(packageSpec: string, range?: string): Promise<string> {
		const npmCommand = this.getNpmCommand();
		const stdout = await this.runCommandCapture(
			npmCommand.command,
			[...npmCommand.args, "view", packageSpec, "version", "--json"],
			{ cwd: this.cwd, timeoutMs: NETWORK_TIMEOUT_MS },
		);
		const raw = stdout.trim();
		if (!raw) throw new Error("Empty response from npm view");
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed === "string") {
			return parsed;
		}
		if (Array.isArray(parsed)) {
			const versions = parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
			const latest = range ? maxSatisfying(versions, range) : [...versions].sort(rcompare)[0];
			if (latest) return latest;
		}
		throw new Error("Unexpected response from npm view");
	}

	private async runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
		if (tasks.length === 0) {
			return [];
		}

		const results: T[] = new Array(tasks.length);
		let nextIndex = 0;
		const workerCount = Math.max(1, Math.min(limit, tasks.length));

		const worker = async () => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= tasks.length) {
					return;
				}
				results[index] = await tasks[index]();
			}
		};

		await Promise.all(Array.from({ length: workerCount }, () => worker()));
		return results;
	}

	/**
	 * Get a unique identity for a package, ignoring version/ref.
	 * Used to detect when the same package is in both global and project settings.
	 * For git packages, uses normalized host/path to ensure SSH and HTTPS URLs
	 * for the same repository are treated as identical.
	 */
	private getPackageIdentity(source: string, scope?: SourceScope): string {
		if (!scope) return packageSourceIdentity(source, (path) => this.paths.resolvePath(path));
		const baseDir = this.paths.getBaseDir(scope);
		return packageSourceIdentity(source, (path) => this.paths.resolvePathFromBase(path, baseDir));
	}

	/**
	 * Dedupe packages: if same package identity appears in both global and project,
	 * keep only the project one (project wins). A project entry with autoload=false
	 * is a delta over the global entry, so both are kept (delta first).
	 */
	private dedupePackages(
		packages: Array<{ pkg: PackageSource; scope: SourceScope }>,
	): Array<{ pkg: PackageSource; scope: SourceScope }> {
		const result: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		const seen = new Map<string, number>();
		for (const entry of packages) {
			const identity = this.getPackageIdentity(this.getPackageSourceString(entry.pkg), entry.scope);
			const index = seen.get(identity);
			if (index === undefined) {
				seen.set(identity, result.length);
				result.push(entry);
				continue;
			}
			const existing = result[index];
			if (existing?.scope === "project" && entry.scope === "user") {
				if (typeof existing.pkg === "object" && existing.pkg.autoload === false) result.push(entry);
			} else if (entry.scope === "project") {
				result[index] = entry;
			}
		}
		return result;
	}

	private getNpmCommand(): { command: string; args: string[] } {
		const configuredCommand = this.settingsManager.getNpmCommand();
		if (!configuredCommand || configuredCommand.length === 0) {
			return { command: "npm", args: [] };
		}
		const [command, ...args] = configuredCommand;
		if (!command) {
			throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
		}
		return { command, args };
	}

	private getPackageManagerName(): string {
		const npmCommand = this.getNpmCommand();
		const normalizeCommandName = (command: string): string => basename(command).replace(/\.(cmd|exe)$/i, "");
		const supportedPackageManagers = new Set(["npm", "pnpm", "bun"]);
		const directCommand = normalizeCommandName(npmCommand.command);
		const separatorIndex = npmCommand.args.lastIndexOf("--");
		if (separatorIndex >= 0) {
			const wrappedCommand = npmCommand.args[separatorIndex + 1];
			return wrappedCommand ? normalizeCommandName(wrappedCommand) : directCommand;
		}
		if (supportedPackageManagers.has(directCommand)) return directCommand;

		const wrappedPackageManagers = [
			...new Set(
				npmCommand.args.map(normalizeCommandName).filter((command) => supportedPackageManagers.has(command)),
			),
		];
		if (wrappedPackageManagers.length > 1) {
			throw new Error(`Ambiguous npmCommand package managers: ${wrappedPackageManagers.join(", ")}`);
		}
		return wrappedPackageManagers[0] ?? directCommand;
	}

	private async runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void> {
		const npmCommand = this.getNpmCommand();
		await this.runCommand(npmCommand.command, [...npmCommand.args, ...args], options);
	}

	private runNpmCommandSync(args: string[]): string {
		const npmCommand = this.getNpmCommand();
		return this.runCommandSync(npmCommand.command, [...npmCommand.args, ...args]);
	}

	private ensureNpmProject(installRoot: string): void {
		if (!existsSync(installRoot)) {
			mkdirSync(installRoot, { recursive: true });
		}
		markPathIgnoredByCloudSync(installRoot);
		this.ensureGitIgnore(installRoot);
		const packageJsonPath = join(installRoot, "package.json");
		if (!existsSync(packageJsonPath)) {
			const pkgJson = { name: "pi-extensions", private: true };
			writeFileSync(packageJsonPath, JSON.stringify(pkgJson, null, 2), "utf-8");
		}
	}

	private ensureGitIgnore(dir: string): void {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const ignorePath = join(dir, ".gitignore");
		if (!existsSync(ignorePath)) {
			writeFileSync(ignorePath, "*\n!.gitignore\n", "utf-8");
		}
	}

	private getGlobalNpmRoot(): string {
		const npmCommand = this.getNpmCommand();
		const commandKey = [npmCommand.command, ...npmCommand.args].join("\0");
		if (this.globalNpmRoot && this.globalNpmRootCommandKey === commandKey) {
			return this.globalNpmRoot;
		}
		if (this.getPackageManagerName() === "bun") {
			const binDir = this.runNpmCommandSync(["pm", "bin", "-g"]).trim();
			this.globalNpmRoot = join(dirname(binDir), "install", "global", "node_modules");
		} else {
			this.globalNpmRoot = this.runNpmCommandSync(["root", "-g"]).trim();
		}
		this.globalNpmRootCommandKey = commandKey;
		return this.globalNpmRoot;
	}

	private getPnpmGlobalPackagePath(packageName: string): string | undefined {
		if (this.getPackageManagerName() !== "pnpm") {
			return undefined;
		}

		const output = this.runNpmCommandSync(["list", "-g", "--depth", "0", "--json"]);
		const entries = JSON.parse(output) as Array<{ dependencies?: Record<string, { path?: string }> }>;
		for (const entry of entries) {
			const path = entry.dependencies?.[packageName]?.path;
			if (path) return path;
		}
		return undefined;
	}

	private getLegacyGlobalNpmInstallPath(source: NpmSource): string | undefined {
		try {
			return this.getPnpmGlobalPackagePath(source.name) ?? join(this.getGlobalNpmRoot(), source.name);
		} catch {
			return undefined;
		}
	}

	private getNpmInstallPath(source: NpmSource, scope: SourceScope): string {
		const managedPath = this.paths.getManagedNpmInstallPath(source.name, scope);
		if (scope !== "user" || existsSync(managedPath)) {
			return managedPath;
		}
		const legacyPath = this.getLegacyGlobalNpmInstallPath(source);
		return legacyPath && existsSync(legacyPath) ? legacyPath : managedPath;
	}

	private collectPackageResources(
		packageRoot: string,
		accumulator: ResourceAccumulator,
		filter: PackageFilter | undefined,
		metadata: PathMetadata,
	): boolean {
		if (filter) {
			for (const resourceType of RESOURCE_TYPES) {
				const patterns = filter[resourceType];
				const target = this.getTargetMap(accumulator, resourceType);
				if (filter.autoload === false) {
					this.applyPackageDeltaFilter(packageRoot, patterns ?? [], resourceType, target, metadata);
				} else if (patterns !== undefined) {
					this.applyPackageFilter(packageRoot, patterns, resourceType, target, metadata);
				} else {
					this.collectDefaultResources(packageRoot, resourceType, target, metadata);
				}
			}
			return true;
		}

		const manifest = readCandyManifest(join(packageRoot, "package.json"));
		if (manifest) {
			for (const resourceType of RESOURCE_TYPES) {
				const entries = manifest[resourceType as keyof CandyManifest];
				this.addManifestEntries(
					entries,
					packageRoot,
					resourceType,
					this.getTargetMap(accumulator, resourceType),
					metadata,
				);
			}
			return true;
		}

		let hasAnyDir = false;
		for (const resourceType of RESOURCE_TYPES) {
			const dir = join(packageRoot, resourceType);
			if (existsSync(dir)) {
				// Collect all files from the directory (all enabled by default)
				const files = collectResourceFiles(dir, resourceType);
				for (const f of files) {
					this.addResource(this.getTargetMap(accumulator, resourceType), f, metadata, true);
				}
				hasAnyDir = true;
			}
		}
		return hasAnyDir;
	}

	private collectDefaultResources(
		packageRoot: string,
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		const manifest = readCandyManifest(join(packageRoot, "package.json"));
		const entries = manifest?.[resourceType as keyof CandyManifest];
		if (entries) {
			this.addManifestEntries(entries, packageRoot, resourceType, target, metadata);
			return;
		}
		const dir = join(packageRoot, resourceType);
		if (existsSync(dir)) {
			// Collect all files from the directory (all enabled by default)
			const files = collectResourceFiles(dir, resourceType);
			for (const f of files) {
				this.addResource(target, f, metadata, true);
			}
		}
	}

	private applyPackageFilter(
		packageRoot: string,
		userPatterns: string[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		const { allFiles } = this.collectManifestFiles(packageRoot, resourceType);

		if (userPatterns.length === 0) {
			// Empty array explicitly disables all resources of this type
			for (const f of allFiles) {
				this.addResource(target, f, metadata, false);
			}
			return;
		}

		// Apply user patterns
		const enabledByUser = applyPatterns(allFiles, userPatterns, packageRoot);

		for (const f of allFiles) {
			const enabled = enabledByUser.has(f);
			this.addResource(target, f, metadata, enabled);
		}
	}

	private applyPackageDeltaFilter(
		packageRoot: string,
		userPatterns: string[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		if (userPatterns.length === 0) {
			return;
		}

		const { allFiles } = this.collectManifestFiles(packageRoot, resourceType);
		const enabledByUser = applyAutoloadDisabledPatterns(allFiles, userPatterns, packageRoot);
		for (const [filePath, enabled] of enabledByUser) {
			this.addResource(target, filePath, metadata, enabled);
		}
	}

	/**
	 * Collect all files from a package for a resource type, applying manifest patterns.
	 * Returns { allFiles, enabledByManifest } where enabledByManifest is the set of files
	 * that pass the manifest's own patterns.
	 */
	private collectManifestFiles(
		packageRoot: string,
		resourceType: ResourceType,
	): { allFiles: string[]; enabledByManifest: Set<string> } {
		const manifest = readCandyManifest(join(packageRoot, "package.json"));
		const entries = manifest?.[resourceType as keyof CandyManifest];
		if (entries && entries.length > 0) {
			const allFiles = this.collectFilesFromManifestEntries(entries, packageRoot, resourceType);
			const manifestPatterns = entries.filter(isOverridePattern);
			const enabledByManifest =
				manifestPatterns.length > 0 ? applyPatterns(allFiles, manifestPatterns, packageRoot) : new Set(allFiles);
			return { allFiles: Array.from(enabledByManifest), enabledByManifest };
		}

		const conventionDir = join(packageRoot, resourceType);
		if (!existsSync(conventionDir)) {
			return { allFiles: [], enabledByManifest: new Set() };
		}
		const allFiles = collectResourceFiles(conventionDir, resourceType);
		return { allFiles, enabledByManifest: new Set(allFiles) };
	}

	private addManifestEntries(
		entries: string[] | undefined,
		root: string,
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		if (!entries) return;

		const allFiles = this.collectFilesFromManifestEntries(entries, root, resourceType);
		const patterns = entries.filter(isOverridePattern);
		const enabledPaths = applyPatterns(allFiles, patterns, root);

		for (const f of allFiles) {
			if (enabledPaths.has(f)) {
				this.addResource(target, f, metadata, true);
			}
		}
	}

	private collectFilesFromManifestEntries(entries: string[], root: string, resourceType: ResourceType): string[] {
		const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
		const resolved = sourceEntries.flatMap((entry) => {
			if (!hasGlobPattern(entry)) {
				return [resolve(root, entry)];
			}

			return expandPackageGlob(entry, root);
		});
		return this.collectFilesFromPaths(resolved, resourceType);
	}

	private resolveLocalEntries(
		entries: string[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
		baseDir: string,
	): void {
		if (entries.length === 0) return;

		// Collect all files from plain entries (non-pattern entries)
		const { plain, patterns } = splitPatterns(entries);
		const resolvedPlain = plain.map((p) => this.paths.resolvePathFromBase(p, baseDir));
		const allFiles = this.collectFilesFromPaths(resolvedPlain, resourceType);

		// Determine which files are enabled based on patterns
		const enabledPaths = applyPatterns(allFiles, patterns, baseDir);

		// Add all files with their enabled state
		for (const f of allFiles) {
			this.addResource(target, f, metadata, enabledPaths.has(f));
		}
	}

	private addAutoDiscoveredResources(
		accumulator: ResourceAccumulator,
		globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>,
		projectSettings: ReturnType<SettingsManager["getProjectSettings"]>,
		globalBaseDir: string,
		projectBaseDir: string,
	): void {
		const userMetadata: PathMetadata = {
			source: "auto",
			scope: "user",
			origin: "top-level",
			baseDir: globalBaseDir,
		};
		const projectMetadata: PathMetadata = {
			source: "auto",
			scope: "project",
			origin: "top-level",
			baseDir: projectBaseDir,
		};

		const userOverrides = {
			extensions: (globalSettings.extensions ?? []) as string[],
			skills: (globalSettings.skills ?? []) as string[],
			prompts: (globalSettings.prompts ?? []) as string[],
			themes: (globalSettings.themes ?? []) as string[],
		};
		const projectOverrides = {
			extensions: (projectSettings.extensions ?? []) as string[],
			skills: (projectSettings.skills ?? []) as string[],
			prompts: (projectSettings.prompts ?? []) as string[],
			themes: (projectSettings.themes ?? []) as string[],
		};

		const userDirs = {
			extensions: join(globalBaseDir, "extensions"),
			skills: join(globalBaseDir, "skills"),
			prompts: join(globalBaseDir, "prompts"),
			themes: join(globalBaseDir, "themes"),
		};
		const projectDirs = {
			extensions: join(projectBaseDir, "extensions"),
			skills: join(projectBaseDir, "skills"),
			prompts: join(projectBaseDir, "prompts"),
			themes: join(projectBaseDir, "themes"),
		};
		const userAgentsSkillsDir = join(this.paths.getHomeDir(), ".agents", "skills");
		const projectTrusted = this.settingsManager.isProjectTrusted();
		const projectAgentsSkillDirs = projectTrusted
			? collectAncestorAgentsSkillDirs(this.cwd).filter((dir) => resolve(dir) !== resolve(userAgentsSkillsDir))
			: [];

		const addResources = (
			resourceType: ResourceType,
			paths: string[],
			metadata: PathMetadata,
			overrides: string[],
			baseDir: string,
		) => {
			const target = this.getTargetMap(accumulator, resourceType);
			for (const path of paths) {
				const enabled = isEnabledByOverrides(path, overrides, baseDir);
				this.addResource(target, path, metadata, enabled);
			}
		};

		if (projectTrusted) {
			// Project extensions from .candy/
			addResources(
				"extensions",
				collectAutoExtensionEntries(projectDirs.extensions),
				projectMetadata,
				projectOverrides.extensions,
				projectBaseDir,
			);

			// Project skills from .candy/
			addResources(
				"skills",
				collectAutoSkillEntries(projectDirs.skills, "candy"),
				projectMetadata,
				projectOverrides.skills,
				projectBaseDir,
			);
		}

		// Project skills from .agents/ (each with its own baseDir)
		for (const agentsSkillsDir of projectAgentsSkillDirs) {
			const agentsBaseDir = dirname(agentsSkillsDir); // the .agents directory
			const agentsMetadata: PathMetadata = {
				...projectMetadata,
				baseDir: agentsBaseDir,
			};
			addResources(
				"skills",
				collectAutoSkillEntries(agentsSkillsDir, "agents"),
				agentsMetadata,
				projectOverrides.skills,
				agentsBaseDir,
			);
		}

		if (projectTrusted) {
			addResources(
				"prompts",
				collectAutoPromptEntries(projectDirs.prompts),
				projectMetadata,
				projectOverrides.prompts,
				projectBaseDir,
			);
			addResources(
				"themes",
				collectAutoThemeEntries(projectDirs.themes),
				projectMetadata,
				projectOverrides.themes,
				projectBaseDir,
			);
		}

		// User extensions from ~/.candy/agent/
		addResources(
			"extensions",
			collectAutoExtensionEntries(userDirs.extensions),
			userMetadata,
			userOverrides.extensions,
			globalBaseDir,
		);

		// User skills from ~/.candy/agent/
		addResources(
			"skills",
			collectAutoSkillEntries(userDirs.skills, "candy"),
			userMetadata,
			userOverrides.skills,
			globalBaseDir,
		);

		// User skills from ~/.agents/ (with its own baseDir)
		const userAgentsBaseDir = dirname(userAgentsSkillsDir);
		const userAgentsMetadata: PathMetadata = {
			...userMetadata,
			baseDir: userAgentsBaseDir,
		};
		addResources(
			"skills",
			collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
			userAgentsMetadata,
			userOverrides.skills,
			userAgentsBaseDir,
		);

		addResources(
			"prompts",
			collectAutoPromptEntries(userDirs.prompts),
			userMetadata,
			userOverrides.prompts,
			globalBaseDir,
		);
		addResources(
			"themes",
			collectAutoThemeEntries(userDirs.themes),
			userMetadata,
			userOverrides.themes,
			globalBaseDir,
		);
	}

	private collectFilesFromPaths(paths: string[], resourceType: ResourceType): string[] {
		const files: string[] = [];
		for (const p of paths) {
			if (!existsSync(p)) continue;

			try {
				const stats = statSync(p);
				if (stats.isFile()) {
					files.push(p);
				} else if (stats.isDirectory()) {
					files.push(...collectResourceFiles(p, resourceType));
				}
			} catch {
				// Ignore errors
			}
		}
		return files;
	}

	private getTargetMap(
		accumulator: ResourceAccumulator,
		resourceType: ResourceType,
	): Map<string, { metadata: PathMetadata; enabled: boolean }> {
		switch (resourceType) {
			case "extensions":
				return accumulator.extensions;
			case "skills":
				return accumulator.skills;
			case "prompts":
				return accumulator.prompts;
			case "themes":
				return accumulator.themes;
			default:
				throw new Error(`Unknown resource type: ${resourceType}`);
		}
	}

	private addResource(
		map: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		path: string,
		metadata: PathMetadata,
		enabled: boolean,
	): void {
		if (!path) return;
		if (!map.has(path)) {
			map.set(path, { metadata, enabled });
		}
	}

	private createAccumulator(): ResourceAccumulator {
		return {
			extensions: new Map(),
			skills: new Map(),
			prompts: new Map(),
			themes: new Map(),
		};
	}

	private toResolvedPaths(accumulator: ResourceAccumulator): ResolvedPaths {
		const mapToResolved = (
			entries: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		): ResolvedResource[] => {
			const resolved = Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({
				path,
				enabled,
				metadata,
			}));
			resolved.sort((a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata));

			const seen = new Set<string>();
			return resolved.filter((entry) => {
				const canonicalPath = canonicalizePath(entry.path);
				if (seen.has(canonicalPath)) return false;
				seen.add(canonicalPath);
				return true;
			});
		};

		return {
			extensions: mapToResolved(accumulator.extensions),
			skills: mapToResolved(accumulator.skills),
			prompts: mapToResolved(accumulator.prompts),
			themes: mapToResolved(accumulator.themes),
		};
	}

	private spawnCommand(command: string, args: string[], options?: { cwd?: string }): ChildProcess {
		const env = getEnv();
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: isStdoutTakenOver() ? ["ignore", 2, 2] : "inherit",
			env,
		});
	}

	private spawnCaptureCommand(
		command: string,
		args: string[],
		options?: { cwd?: string; env?: Record<string, string> },
	): ChildProcessByStdio<null, Readable, Readable> {
		const baseEnv = getEnv();
		const env = options?.env ? { ...baseEnv, ...options.env } : baseEnv;
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});
	}

	private runCommandCapture(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
	): Promise<string> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnCaptureCommand(command, args, options);
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const timeout =
				typeof options?.timeoutMs === "number"
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, options.timeoutMs)
					: undefined;

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			child.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			child.once("error", (error) => {
				if (timeout) clearTimeout(timeout);
				reject(error);
			});
			child.once("close", (code, signal) => {
				if (timeout) clearTimeout(timeout);
				if (timedOut) {
					reject(new Error(`${command} ${args.join(" ")} timed out after ${options?.timeoutMs}ms`));
					return;
				}
				if (code === 0) {
					resolvePromise(stdout.trim());
					return;
				}
				const exitStatus = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
				reject(new Error(`${command} ${args.join(" ")} failed with ${exitStatus}: ${stderr || stdout}`));
			});
		});
	}

	private runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnCommand(command, args, options);
			child.on("error", reject);
			child.on("exit", (code) => {
				if (code === 0) {
					resolvePromise();
				} else {
					reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
				}
			});
		});
	}

	private runCommandSync(command: string, args: string[]): string {
		const env = getEnv();
		const result = spawnProcessSync(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf-8",
			env,
		});
		if (result.error || result.status !== 0) {
			throw new Error(
				`Failed to run ${command} ${args.join(" ")}: ${result.error?.message || result.stderr || result.stdout}`,
			);
		}
		return (result.stdout || result.stderr || "").trim();
	}
}
