import { dirname, join, relative } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { canonicalizePath, isLocalPath, resolvePath } from "../utils/paths.ts";
import type { PathMetadata, ResolvedPaths } from "./package-manager.ts";
import type { PackageSource, SettingsManager } from "./settings-manager.ts";

export type ResourceType = "extensions" | "skills" | "prompts" | "themes";
export type ConfigWriteScope = "global" | "project";
type SettingsScope = "user" | "project";
export type ProjectOverrideState = "inherit" | "load" | "unload";

export interface ResourceConfigurationItem {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
	resourceType: ResourceType;
}

const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const satisfies readonly ResourceType[];

export class ResourceConfiguration {
	private readonly settingsManager: SettingsManager;
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly inheritedEnabledByKey = new Map<string, boolean>();
	private writeScope: ConfigWriteScope;

	constructor(
		settingsManager: SettingsManager,
		cwd: string,
		agentDir: string,
		globalResolved: ResolvedPaths,
		writeScope: ConfigWriteScope = "global",
	) {
		this.settingsManager = settingsManager;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.writeScope = writeScope;
		for (const resourceType of RESOURCE_TYPES) {
			for (const item of globalResolved[resourceType]) {
				this.inheritedEnabledByKey.set(`${resourceType}:${canonicalizePath(item.path)}`, item.enabled);
			}
		}
	}

	setWriteScope(scope: ConfigWriteScope): void {
		this.writeScope = scope;
	}

	toggleResource(item: ResourceConfigurationItem): boolean | undefined {
		if (this.writeScope === "project") {
			const state = this.getNextOverrideState(item);
			if (!this.setProjectResourceOverride(item, state)) return undefined;
			return state === "inherit" ? this.getInheritedEnabled(item) : state === "load";
		}

		const enabled = !item.enabled;
		if (item.metadata.origin === "top-level") {
			this.toggleTopLevelResource(item, enabled);
		} else {
			this.togglePackageResource(item, enabled);
		}
		return enabled;
	}

	private toggleTopLevelResource(item: ResourceConfigurationItem, enabled: boolean): void {
		const scope = item.metadata.scope as "user" | "project";
		const settings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();

		const arrayKey = item.resourceType as "extensions" | "skills" | "prompts" | "themes";
		const current = (settings[arrayKey] ?? []) as string[];

		// Generate pattern for this resource
		const pattern = this.getResourcePattern(item);
		const disablePattern = `-${pattern}`;
		const enablePattern = `+${pattern}`;

		// Filter out existing patterns for this resource
		const updated = current.filter((p) => {
			const stripped = p.startsWith("!") || p.startsWith("+") || p.startsWith("-") ? p.slice(1) : p;
			return stripped !== pattern;
		});

		if (enabled) {
			updated.push(enablePattern);
		} else {
			updated.push(disablePattern);
		}

		if (scope === "project") {
			if (arrayKey === "extensions") {
				this.settingsManager.setProjectExtensionPaths(updated);
			} else if (arrayKey === "skills") {
				this.settingsManager.setProjectSkillPaths(updated);
			} else if (arrayKey === "prompts") {
				this.settingsManager.setProjectPromptTemplatePaths(updated);
			} else if (arrayKey === "themes") {
				this.settingsManager.setProjectThemePaths(updated);
			}
		} else {
			if (arrayKey === "extensions") {
				this.settingsManager.setExtensionPaths(updated);
			} else if (arrayKey === "skills") {
				this.settingsManager.setSkillPaths(updated);
			} else if (arrayKey === "prompts") {
				this.settingsManager.setPromptTemplatePaths(updated);
			} else if (arrayKey === "themes") {
				this.settingsManager.setThemePaths(updated);
			}
		}
	}

	private togglePackageResource(item: ResourceConfigurationItem, enabled: boolean): void {
		const scope = item.metadata.scope as "user" | "project";
		const settings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();

		const packages = [...(settings.packages ?? [])] as PackageSource[];
		const pkgIndex = packages.findIndex((pkg) => {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			return source === item.metadata.source;
		});

		if (pkgIndex === -1) return;

		let pkg = packages[pkgIndex];

		// Convert string to object form if needed
		if (typeof pkg === "string") {
			pkg = { source: pkg };
			packages[pkgIndex] = pkg;
		}

		// Get the resource array for this type
		const arrayKey = item.resourceType as "extensions" | "skills" | "prompts" | "themes";
		const current = (pkg[arrayKey] ?? []) as string[];

		// Generate pattern relative to package root
		const pattern = this.getPackageResourcePattern(item);
		const disablePattern = `-${pattern}`;
		const enablePattern = `+${pattern}`;

		// Filter out existing patterns for this resource
		const updated = current.filter((p) => {
			const stripped = p.startsWith("!") || p.startsWith("+") || p.startsWith("-") ? p.slice(1) : p;
			return stripped !== pattern;
		});

		if (enabled) {
			updated.push(enablePattern);
		} else {
			updated.push(disablePattern);
		}

		(pkg as Record<string, unknown>)[arrayKey] = updated.length > 0 ? updated : undefined;

		// Clean up empty filter object
		const hasFilters = ["extensions", "skills", "prompts", "themes"].some(
			(k) => (pkg as Record<string, unknown>)[k] !== undefined,
		);
		if (!hasFilters) {
			packages[pkgIndex] = (pkg as { source: string }).source;
		}

		if (scope === "project") {
			this.settingsManager.setProjectPackages(packages);
		} else {
			this.settingsManager.setPackages(packages);
		}
	}

	private setProjectResourceOverride(item: ResourceConfigurationItem, state: ProjectOverrideState): boolean {
		return item.metadata.origin === "top-level"
			? this.setProjectTopLevelOverride(item, state)
			: this.setProjectPackageOverride(item, state);
	}

	private setProjectTopLevelOverride(item: ResourceConfigurationItem, state: ProjectOverrideState): boolean {
		const current = (this.settingsManager.getProjectSettings()[item.resourceType] ?? []) as string[];
		const pattern = this.isInheritedGlobalItem(item) ? item.path : this.getResourcePatternForScope(item, "project");
		const patterns = this.getTopLevelOverridePatterns(item, "project");
		const updated = current.filter((entry) => {
			const target = this.getPatternEntryTarget(entry);
			if ((entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-")) && patterns.has(target))
				return false;
			return !(state === "inherit" && this.isInheritedGlobalItem(item) && target === pattern);
		});
		if (state !== "inherit") {
			if (this.isInheritedGlobalItem(item) && !updated.includes(pattern)) updated.push(pattern);
			updated.push(`${state === "load" ? "+" : "-"}${pattern}`);
		}
		this.setProjectTopLevelPaths(item.resourceType, updated);
		return true;
	}

	private setProjectTopLevelPaths(key: ResourceType, paths: string[]): void {
		if (key === "extensions") this.settingsManager.setProjectExtensionPaths(paths);
		else if (key === "skills") this.settingsManager.setProjectSkillPaths(paths);
		else if (key === "prompts") this.settingsManager.setProjectPromptTemplatePaths(paths);
		else this.settingsManager.setProjectThemePaths(paths);
	}

	private setProjectPackageOverride(item: ResourceConfigurationItem, state: ProjectOverrideState): boolean {
		const packages = [...(this.settingsManager.getProjectSettings().packages ?? [])] as PackageSource[];
		let pkgIndex = packages.findIndex((pkg) =>
			this.packageSourceStringMatches(
				item.metadata.source,
				this.getItemScope(item),
				typeof pkg === "string" ? pkg : pkg.source,
				"project",
			),
		);
		if (pkgIndex === -1) {
			if (state === "inherit") return false;
			packages.push(this.createPackageOverrideSource(item));
			pkgIndex = packages.length - 1;
		}
		let pkg = packages[pkgIndex];
		if (pkg === undefined) return false;
		if (typeof pkg === "string") {
			pkg = { source: pkg };
			packages[pkgIndex] = pkg;
		}
		const pattern = this.getPackageResourcePattern(item);
		const updated = ((pkg[item.resourceType] ?? []) as string[]).filter(
			(entry) => this.getPatternEntryTarget(entry) !== pattern,
		);
		if (state !== "inherit") updated.push(`${state === "load" ? "+" : "-"}${pattern}`);
		(pkg as Record<string, unknown>)[item.resourceType] = updated.length > 0 ? updated : undefined;
		if (!RESOURCE_TYPES.some((key) => (pkg as Record<string, unknown>)[key] !== undefined)) {
			if (pkg.autoload === false) packages.splice(pkgIndex, 1);
			else packages[pkgIndex] = pkg.source;
		}
		this.settingsManager.setProjectPackages(packages);
		return true;
	}

	private getNextOverrideState(item: ResourceConfigurationItem): ProjectOverrideState {
		const state = this.getProjectOverrideState(item);
		const inheritedEnabled = this.getInheritedEnabled(item);
		if (state === "inherit") return inheritedEnabled ? "unload" : "load";
		if (state === "unload") return inheritedEnabled ? "load" : "inherit";
		return inheritedEnabled ? "inherit" : "unload";
	}

	getProjectOverrideState(item: ResourceConfigurationItem): ProjectOverrideState {
		if (this.writeScope !== "project") return "inherit";
		if (item.metadata.origin === "top-level") {
			return this.getOverrideStateFromEntries(
				(this.settingsManager.getProjectSettings()[item.resourceType] ?? []) as string[],
				this.getTopLevelOverridePatterns(item, "project"),
				false,
			);
		}
		const pkg = this.findMatchingPackageSource(item, "project");
		if (typeof pkg !== "object") return "inherit";
		const entries = pkg[item.resourceType];
		if (entries === undefined) return "inherit";
		return this.getOverrideStateFromEntries(
			entries,
			new Set([this.getPackageResourcePattern(item)]),
			pkg.autoload !== false,
		);
	}

	private getOverrideStateFromEntries(
		entries: string[],
		patterns: Set<string>,
		emptyArrayIsUnload: boolean,
	): ProjectOverrideState {
		if (entries.length === 0 && emptyArrayIsUnload) return "unload";
		let state: ProjectOverrideState = "inherit";
		for (const entry of entries) {
			if (!patterns.has(this.getPatternEntryTarget(entry))) continue;
			if (entry.startsWith("!") || entry.startsWith("-")) state = "unload";
			else state = "load";
		}
		return state;
	}

	getInheritedEnabled(item: ResourceConfigurationItem): boolean {
		return (
			this.inheritedEnabledByKey.get(this.getResourceItemKey(item)) ??
			(this.getItemScope(item) === "user" ? item.enabled : true)
		);
	}

	isInheritedGlobalItem(item: ResourceConfigurationItem): boolean {
		return this.getItemScope(item) === "user" || this.inheritedEnabledByKey.has(this.getResourceItemKey(item));
	}

	private getTopLevelOverridePatterns(item: ResourceConfigurationItem, scope: SettingsScope): Set<string> {
		const baseDir = this.getTopLevelBaseDir(scope);
		const patterns = new Set<string>([
			this.getResourcePatternForScope(item, scope),
			item.path,
			relative(baseDir, item.path),
		]);
		if (item.metadata.baseDir) patterns.add(relative(item.metadata.baseDir, item.path));
		return patterns;
	}

	private getResourcePatternForScope(item: ResourceConfigurationItem, scope: SettingsScope): string {
		const sourceScope = this.getItemScope(item);
		if (scope !== sourceScope) return item.path;
		const baseDir = item.metadata.baseDir ?? this.getTopLevelBaseDir(sourceScope);
		return relative(baseDir, item.path);
	}

	private createPackageOverrideSource(item: ResourceConfigurationItem): PackageSource {
		const source = item.metadata.source;
		if (!isLocalPath(source)) return { source, autoload: false };
		const sourcePath = resolvePath(source, this.getTopLevelBaseDir(this.getItemScope(item)), { trim: true });
		return { source: relative(this.getTopLevelBaseDir("project"), sourcePath) || ".", autoload: false };
	}

	private packageSourceStringMatches(
		leftSource: string,
		leftScope: SettingsScope,
		rightSource: string,
		rightScope: SettingsScope,
	): boolean {
		if (leftSource === rightSource) return true;
		if (!isLocalPath(leftSource) || !isLocalPath(rightSource)) return false;
		const left = resolvePath(leftSource, this.getTopLevelBaseDir(leftScope), { trim: true });
		const right = resolvePath(rightSource, this.getTopLevelBaseDir(rightScope), { trim: true });
		return left === right;
	}

	private findMatchingPackageSource(
		item: ResourceConfigurationItem,
		targetScope: SettingsScope,
	): PackageSource | undefined {
		const settings =
			targetScope === "project"
				? this.settingsManager.getProjectSettings()
				: this.settingsManager.getGlobalSettings();
		return (settings.packages ?? []).find((pkg) =>
			this.packageSourceStringMatches(
				item.metadata.source,
				this.getItemScope(item),
				typeof pkg === "string" ? pkg : pkg.source,
				targetScope,
			),
		);
	}

	private getPatternEntryTarget(entry: string): string {
		return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-") ? entry.slice(1) : entry;
	}

	private getResourceItemKey(item: ResourceConfigurationItem): string {
		return `${item.resourceType}:${canonicalizePath(item.path)}`;
	}

	getItemScope(item: ResourceConfigurationItem): SettingsScope {
		return item.metadata.scope === "project" ? "project" : "user";
	}

	private getTopLevelBaseDir(scope: "user" | "project"): string {
		return scope === "project" ? join(this.cwd, CONFIG_DIR_NAME) : this.agentDir;
	}

	private getResourcePattern(item: ResourceConfigurationItem): string {
		const scope = item.metadata.scope as "user" | "project";
		const baseDir = item.metadata.baseDir ?? this.getTopLevelBaseDir(scope);
		return relative(baseDir, item.path);
	}

	private getPackageResourcePattern(item: ResourceConfigurationItem): string {
		const baseDir = item.metadata.baseDir ?? dirname(item.path);
		return relative(baseDir, item.path);
	}
}
