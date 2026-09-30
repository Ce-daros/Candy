import { isDeepStrictEqual } from "node:util";
import type { ThinkingLevel } from "@candy/agent-core";
import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS, type Model } from "@candy/ai";
import type { ScrollViewScrollbar, TerminalCapabilities } from "@candy/tui";
import { join } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";
import { FileSettingsStorage, InMemorySettingsStorage, type SettingsStorage } from "./settings-storage.ts";
import {
	type AnimationIntensity,
	CACHE_WARMING_MODES,
	type CacheWarmingMode,
	type CompactionModelOverride,
	DEFAULT_COMPACTION_TOKEN_SETTINGS,
	type DefaultProjectTrust,
	type FullscreenExitOutput,
	type MermaidRenderingMode,
	type PackageSource,
	type ScopedModelRef,
	type Settings,
	type SettingsScope,
	type SettingValueSource,
	type ThinkingBudgetsSettings,
	type TransportSetting,
	type WarningSettings,
} from "./settings-types.ts";

export { FileSettingsStorage, InMemorySettingsStorage, type SettingsStorage } from "./settings-storage.ts";
export * from "./settings-types.ts";

function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeObjects(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };

	for (const key of Object.keys(overrides)) {
		const overrideValue = overrides[key];
		if (overrideValue === undefined) {
			continue;
		}

		const baseValue = base[key];
		result[key] =
			isMergeableObject(baseValue) && isMergeableObject(overrideValue)
				? deepMergeObjects(baseValue, overrideValue)
				: overrideValue;
	}

	return result;
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	return deepMergeObjects(base as Record<string, unknown>, overrides as Record<string, unknown>) as Settings;
}

function changedFields(before: Settings, after: Settings): (keyof Settings)[] {
	const fields = new Set([...Object.keys(before), ...Object.keys(after)] as (keyof Settings)[]);
	return [...fields].filter((field) => !isDeepStrictEqual(before[field], after[field]));
}

function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) {
		return timeoutMs;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
}

export interface SettingsError {
	scope: SettingsScope;
	path?: string;
	error: Error;
}

type SettingsPaths = Partial<Record<SettingsScope, string>>;

export interface SettingsCommitEvent {
	scope: SettingsScope | "runtime";
	fields: readonly (keyof Settings)[];
}

function toSettingsError(scope: SettingsScope, error: unknown, path?: string): SettingsError {
	return {
		scope,
		...(path ? { path } : {}),
		error: error instanceof Error ? error : new Error(String(error)),
	};
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings;
	private runtimeOverrides: Settings = {};
	private projectTrusted: boolean;
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private commitTail: Promise<void> = Promise.resolve();
	private errors: SettingsError[];
	private settingsPaths: SettingsPaths;
	private commitListeners = new Set<(event: SettingsCommitEvent) => void>();

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
		settingsPaths: SettingsPaths = {},
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.projectTrusted = projectTrusted;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.settingsPaths = settingsPaths;
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Create a SettingsManager that loads from files */
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		const storage = new FileSettingsStorage(resolvedCwd, resolvedAgentDir);
		return SettingsManager.fromStorageWithPaths(storage, options, {
			global: join(resolvedAgentDir, "settings.json"),
			project: join(resolvedCwd, CONFIG_DIR_NAME, "settings.json"),
		});
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		return SettingsManager.fromStorageWithPaths(storage, options);
	}

	/** Create a manager while retaining optional file paths for reported storage errors. */
	private static fromStorageWithPaths(
		storage: SettingsStorage,
		options: SettingsManagerCreateOptions,
		settingsPaths: SettingsPaths = {},
	): SettingsManager {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push(toSettingsError("global", globalLoad.error, settingsPaths.global));
		}
		if (projectLoad.error) {
			initialErrors.push(toSettingsError("project", projectLoad.error, settingsPaths.project));
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
			settingsPaths,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage, options);
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = true): Settings {
		if (scope === "project" && !projectTrusted) {
			return {};
		}

		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(stripBom(content));
		return SettingsManager.migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope, projectTrusted), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		delete settings.enabledModels;

		// Migrate queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// Migrate legacy websockets boolean -> transport enum
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// Migrate old skills object format to new array format
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		// Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
		if (
			"retry" in settings &&
			typeof settings.retry === "object" &&
			settings.retry !== null &&
			!Array.isArray(settings.retry)
		) {
			const retrySettings = settings.retry as Record<string, unknown>;
			const providerSettings =
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? (retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				typeof retrySettings.maxDelayMs === "number" &&
				(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
			) {
				retrySettings.provider = {
					...(providerSettings ?? {}),
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			delete retrySettings.maxDelayMs;
		}

		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getSetting<K extends keyof Settings>(field: K): Settings[K] | undefined {
		return structuredClone(this.settings[field]);
	}

	getSettingSource(field: keyof Settings, nestedPath?: string): SettingValueSource {
		const contains = (settings: Settings): boolean => {
			const value = settings[field];
			if (nestedPath === undefined) return Object.hasOwn(settings, field);
			return isMergeableObject(value) && Object.hasOwn(value, nestedPath);
		};
		if (contains(this.runtimeOverrides)) return "runtime";
		if (this.projectTrusted && contains(this.projectSettings)) return "project";
		if (contains(this.globalSettings)) return "global";
		return "default";
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		if (this.projectTrusted === trusted) {
			return;
		}

		const previousProjectSettings = this.projectSettings;
		this.projectTrusted = trusted;

		if (!trusted) {
			this.projectSettings = {};
			this.projectSettingsLoadError = null;
			this.rebuildEffectiveSettings();
			const fields = changedFields(previousProjectSettings, this.projectSettings);
			if (fields.length > 0) this.publishCommit("project", fields);
			return;
		}

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", trusted);
		this.projectSettings = projectLoad.settings;
		this.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.recordError("project", projectLoad.error);
		}
		this.rebuildEffectiveSettings();
		const fields = changedFields(previousProjectSettings, this.projectSettings);
		if (fields.length > 0) this.publishCommit("project", fields);
	}

	async reload(): Promise<void> {
		await this.commitTail;
		const previousGlobalSettings = this.globalSettings;
		const previousProjectSettings = this.projectSettings;
		const errors: Error[] = [];
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
			errors.push(globalLoad.error);
		}

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", this.projectTrusted);
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
			errors.push(projectLoad.error);
		}

		this.rebuildEffectiveSettings();
		if (!globalLoad.error) {
			const fields = changedFields(previousGlobalSettings, this.globalSettings);
			if (fields.length > 0) this.publishCommit("global", fields);
		}
		if (!projectLoad.error) {
			const fields = changedFields(previousProjectSettings, this.projectSettings);
			if (fields.length > 0) this.publishCommit("project", fields);
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to reload settings");
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.runtimeOverrides = deepMergeSettings(this.runtimeOverrides, overrides);
		this.rebuildEffectiveSettings();
		const fields = Object.keys(overrides) as (keyof Settings)[];
		if (fields.length > 0) this.publishCommit("runtime", fields);
	}

	private assertProjectTrustedForWrite(): void {
		if (!this.projectTrusted) {
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		this.errors.push(toSettingsError(scope, error, this.settingsPaths[scope]));
	}

	private persistTransformed(scope: SettingsScope, transform: (disk: Settings) => Settings): Settings {
		if (scope === "project") this.assertProjectTrustedForWrite();
		const loadError = scope === "global" ? this.globalSettingsLoadError : this.projectSettingsLoadError;
		if (loadError) throw loadError;
		let committed: Settings | undefined;
		this.storage.withLock(scope, (current) => {
			const disk = current
				? SettingsManager.migrateSettings(JSON.parse(stripBom(current)) as Record<string, unknown>)
				: {};
			committed = transform(disk);
			return JSON.stringify(committed, null, 2);
		});
		return committed!;
	}

	private enqueueCommit<T>(task: () => T | Promise<T>): Promise<T> {
		const operation = this.commitTail.then(task);
		this.commitTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	async commitSetting<K extends keyof Settings>(
		scope: SettingsScope,
		field: K,
		value: Settings[K] | undefined,
	): Promise<void> {
		await this.enqueueCommit(() => {
			if (scope === "project") this.assertProjectTrustedForWrite();
			const committed = this.persistTransformed(scope, (disk) => {
				if (value === undefined) delete disk[field];
				else disk[field] = structuredClone(value);
				return disk;
			});
			if (scope === "global") this.globalSettings = committed;
			else this.projectSettings = committed;
			this.rebuildEffectiveSettings();
			this.publishCommit(scope, [field]);
		});
	}

	async commitDefaultModelAndProvider(provider: string | undefined, modelId: string | undefined): Promise<void> {
		await this.enqueueCommit(() => {
			this.globalSettings = this.persistTransformed("global", (disk) => {
				if (provider === undefined) delete disk.defaultProvider;
				else disk.defaultProvider = provider;
				if (modelId === undefined) delete disk.defaultModel;
				else disk.defaultModel = modelId;
				return disk;
			});
			this.rebuildEffectiveSettings();
			this.publishCommit("global", ["defaultProvider", "defaultModel"]);
		});
	}

	async commitNestedSetting<K extends keyof Settings>(
		scope: SettingsScope,
		field: K,
		key: string,
		value: string | number | boolean | undefined,
	): Promise<void> {
		await this.enqueueCommit(() => {
			if (scope === "project") this.assertProjectTrustedForWrite();
			const loadError = scope === "global" ? this.globalSettingsLoadError : this.projectSettingsLoadError;
			if (loadError) throw loadError;
			const committed = this.persistTransformed(scope, (disk) => {
				const next = disk;
				const nested = { ...((next[field] as Record<string, unknown> | undefined) ?? {}) };
				if (value === undefined) delete nested[key];
				else nested[key] = structuredClone(value);
				if (Object.keys(nested).length === 0) delete next[field];
				else next[field] = nested as Settings[K];
				return next;
			});
			if (scope === "global") this.globalSettings = committed;
			else this.projectSettings = committed;
			this.rebuildEffectiveSettings();
			this.publishCommit(scope, [field]);
		});
	}

	async commitModelThinkingLevel(provider: string, modelId: string, level: ThinkingLevel | undefined): Promise<void> {
		await this.enqueueCommit(() => {
			const key = `${provider}/${modelId}`;
			this.globalSettings = this.persistTransformed("global", (disk) => {
				const levels = { ...(disk.modelThinkingLevels ?? {}) };
				if (level === undefined) delete levels[key];
				else levels[key] = level;
				if (Object.keys(levels).length === 0) delete disk.modelThinkingLevels;
				else disk.modelThinkingLevels = levels;
				return disk;
			});
			this.rebuildEffectiveSettings();
			this.publishCommit("global", ["modelThinkingLevels"]);
		});
	}

	async commitModelCompactionOverride(
		provider: string,
		modelId: string,
		field: keyof CompactionModelOverride,
		value: number | undefined,
	): Promise<void> {
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
			throw new Error(`Invalid compaction model override ${field}: ${value}`);
		}
		await this.enqueueCommit(() => {
			const key = `${provider}/${modelId}`;
			this.globalSettings = this.persistTransformed("global", (disk) => {
				const compaction = { ...(disk.compaction ?? {}) };
				const models = { ...(compaction.modelOverrides ?? {}) };
				const model = { ...(models[key] ?? {}) };
				if (value === undefined) delete model[field];
				else model[field] = value;
				if (Object.keys(model).length === 0) delete models[key];
				else models[key] = model;
				if (Object.keys(models).length === 0) delete compaction.modelOverrides;
				else compaction.modelOverrides = models;
				if (Object.keys(compaction).length === 0) delete disk.compaction;
				else disk.compaction = compaction;
				return disk;
			});
			this.rebuildEffectiveSettings();
			this.publishCommit("global", ["compaction"]);
		});
	}

	commitTerminalSetting<K extends keyof NonNullable<Settings["terminal"]>>(
		field: K,
		value: NonNullable<Settings["terminal"]>[K] | undefined,
	): Promise<void> {
		return this.commitNestedSetting("global", "terminal", field, value as string | number | boolean | undefined);
	}

	commitImageSetting<K extends keyof NonNullable<Settings["images"]>>(
		field: K,
		value: NonNullable<Settings["images"]>[K] | undefined,
	): Promise<void> {
		return this.commitNestedSetting("global", "images", field, value);
	}

	commitMarkdownSetting<K extends keyof NonNullable<Settings["markdown"]>>(
		field: K,
		value: NonNullable<Settings["markdown"]>[K] | undefined,
	): Promise<void> {
		return this.commitNestedSetting("global", "markdown", field, value);
	}

	setRuntimeOverride<K extends keyof Settings>(field: K, value: Settings[K] | undefined): void {
		if (value === undefined) delete this.runtimeOverrides[field];
		else this.runtimeOverrides[field] = structuredClone(value);
		this.rebuildEffectiveSettings();
		this.publishCommit("runtime", [field]);
	}

	clearRuntimeOverride<K extends keyof Settings>(field: K): void {
		delete this.runtimeOverrides[field];
		this.rebuildEffectiveSettings();
		this.publishCommit("runtime", [field]);
	}

	subscribe(listener: (event: SettingsCommitEvent) => void): () => void {
		this.commitListeners.add(listener);
		return () => this.commitListeners.delete(listener);
	}

	private publishCommit(scope: SettingsCommitEvent["scope"], fields: readonly (keyof Settings)[]): void {
		const event: SettingsCommitEvent = { scope, fields };
		for (const listener of this.commitListeners) listener(event);
	}

	private rebuildEffectiveSettings(): void {
		this.settings = deepMergeSettings(
			deepMergeSettings(this.globalSettings, this.projectSettings),
			this.runtimeOverrides,
		);
	}

	async flush(): Promise<void> {
		await this.commitTail;
	}

	async flushOrThrow(): Promise<void> {
		await this.commitTail;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): Promise<void> {
		return this.commitSetting("global", "lastChangelogVersion", version);
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultModelAndProvider(provider: string, modelId: string): Promise<void> {
		return this.commitDefaultModelAndProvider(provider, modelId);
	}

	getScopedModels(): ScopedModelRef[] | undefined {
		return this.globalSettings.scopedModels?.map((model) => ({ ...model }));
	}

	setScopedModels(models: ScopedModelRef[] | undefined): Promise<void> {
		return this.commitSetting("global", "scopedModels", models);
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		return this.commitSetting("global", "steeringMode", mode);
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		return this.commitSetting("global", "followUpMode", mode);
	}

	getThemeSetting(): string | undefined {
		const value = this.settings.theme;
		if (typeof value === "string") return value;
		return undefined;
	}

	getTheme(): string | undefined {
		const theme = this.getThemeSetting();
		return theme?.includes("/") ? undefined : theme;
	}

	setTheme(theme: string): Promise<void> {
		return this.commitSetting("global", "theme", theme);
	}

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.commitSetting("global", "defaultThinkingLevel", level);
	}

	getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
		return this.settings.modelThinkingLevels?.[`${provider}/${modelId}`];
	}

	getModelThinkingSettingWithSource(model: Pick<Model<string>, "provider" | "id">): {
		requested: ThinkingLevel | undefined;
		source: SettingValueSource;
		savedGlobalOverride: ThinkingLevel | undefined;
	} {
		const key = `${model.provider}/${model.id}`;
		let source: SettingValueSource;
		if (this.runtimeOverrides.modelThinkingLevels?.[key] !== undefined) source = "runtime-model";
		else if (this.projectSettings.modelThinkingLevels?.[key] !== undefined) source = "project-model";
		else if (this.globalSettings.modelThinkingLevels?.[key] !== undefined) source = "global-model";
		else if (this.runtimeOverrides.defaultThinkingLevel !== undefined) source = "runtime";
		else if (this.projectSettings.defaultThinkingLevel !== undefined) source = "project";
		else if (this.globalSettings.defaultThinkingLevel !== undefined) source = "global";
		else source = "default";
		return {
			requested: this.getModelThinkingLevel(model.provider, model.id) ?? this.getDefaultThinkingLevel(),
			source,
			savedGlobalOverride: this.globalSettings.modelThinkingLevels?.[key],
		};
	}

	getAllModelThinkingLevels(): Record<string, ThinkingLevel> {
		return { ...(this.settings.modelThinkingLevels ?? {}) };
	}

	setModelThinkingLevel(provider: string, modelId: string, level: ThinkingLevel): Promise<void> {
		return this.commitModelThinkingLevel(provider, modelId, level);
	}

	removeModelThinkingLevel(provider: string, modelId: string): Promise<void> {
		return this.commitModelThinkingLevel(provider, modelId, undefined);
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	setTransport(transport: TransportSetting): Promise<void> {
		return this.commitSetting("global", "transport", transport);
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): Promise<void> {
		return this.commitNestedSetting("global", "compaction", "enabled", enabled);
	}

	private getCompactionTokenSetting(
		field: keyof CompactionModelOverride,
		model?: Pick<Model<string>, "provider" | "id">,
	): number {
		const compaction = this.settings.compaction;
		const ordinary = compaction?.[field];
		if (ordinary !== undefined && (typeof ordinary !== "number" || !Number.isSafeInteger(ordinary) || ordinary < 0)) {
			throw new Error(
				`Invalid compaction.${field} setting: ${String(ordinary)}. Expected a non-negative safe integer.`,
			);
		}

		const modelKey = model ? `${model.provider}/${model.id}` : undefined;
		const entry = modelKey !== undefined ? compaction?.modelOverrides?.[modelKey] : undefined;
		if (entry !== undefined && !isMergeableObject(entry)) {
			throw new Error(
				`Invalid compaction.modelOverrides["${modelKey}"] setting: ${String(entry)}. Expected an object.`,
			);
		}
		const override = entry?.[field];
		if (override !== undefined && (typeof override !== "number" || !Number.isSafeInteger(override) || override < 0)) {
			throw new Error(
				`Invalid compaction.modelOverrides["${modelKey}"].${field} setting: ${String(override)}. Expected a non-negative safe integer.`,
			);
		}
		return override ?? ordinary ?? DEFAULT_COMPACTION_TOKEN_SETTINGS[field];
	}

	getCompactionReserveTokens(model?: Pick<Model<string>, "provider" | "id">): number {
		return this.getCompactionTokenSetting("reserveTokens", model);
	}

	getCompactionKeepRecentTokens(model?: Pick<Model<string>, "provider" | "id">): number {
		return this.getCompactionTokenSetting("keepRecentTokens", model);
	}

	getCompactionTokenSettingsWithSources(
		model: Pick<Model<string>, "provider" | "id">,
	): Record<
		keyof CompactionModelOverride,
		{ value: number; source: SettingValueSource; savedGlobalOverride?: number }
	> {
		const key = `${model.provider}/${model.id}`;
		const sourceFor = (field: keyof CompactionModelOverride): SettingValueSource => {
			if (this.runtimeOverrides.compaction?.modelOverrides?.[key]?.[field] !== undefined) return "runtime-model";
			if (this.projectSettings.compaction?.modelOverrides?.[key]?.[field] !== undefined) return "project-model";
			if (this.globalSettings.compaction?.modelOverrides?.[key]?.[field] !== undefined) return "global-model";
			if (this.runtimeOverrides.compaction?.[field] !== undefined) return "runtime";
			if (this.projectSettings.compaction?.[field] !== undefined) return "project";
			if (this.globalSettings.compaction?.[field] !== undefined) return "global";
			return "default";
		};
		return {
			reserveTokens: {
				value: this.getCompactionReserveTokens(model),
				source: sourceFor("reserveTokens"),
				savedGlobalOverride: this.globalSettings.compaction?.modelOverrides?.[key]?.reserveTokens,
			},
			keepRecentTokens: {
				value: this.getCompactionKeepRecentTokens(model),
				source: sourceFor("keepRecentTokens"),
				savedGlobalOverride: this.globalSettings.compaction?.modelOverrides?.[key]?.keepRecentTokens,
			},
		};
	}

	setModelCompactionOverride(
		provider: string,
		modelId: string,
		field: keyof CompactionModelOverride,
		value: number | undefined,
	): Promise<void> {
		return this.commitModelCompactionOverride(provider, modelId, field, value);
	}

	/** Resolve each token setting through model override, ordinary setting, then built-in default. */
	getCompactionSettings(model?: Pick<Model<string>, "provider" | "id">): {
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
	} {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(model),
			keepRecentTokens: this.getCompactionKeepRecentTokens(model),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): Promise<void> {
		return this.commitNestedSetting("global", "retry", "enabled", enabled);
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
			maxAgentDelayMs: this.settings.retry?.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
		};
	}

	getHttpIdleTimeoutMs(): number {
		return parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	setHttpIdleTimeoutMs(timeoutMs: number): Promise<void> {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		return this.commitSetting("global", "httpIdleTimeoutMs", Math.floor(timeoutMs));
	}

	/** Read from global settings only because warming costs money. */
	getCacheWarmingMode(): CacheWarmingMode {
		const mode = this.globalSettings.cacheWarming;
		return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : "streaming";
	}

	setCacheWarmingMode(mode: CacheWarmingMode): Promise<void> {
		return this.commitSetting("global", "cacheWarming", mode);
	}

	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
		};
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? true;
	}

	getShowCacheMissNotices(): boolean {
		return this.settings.showCacheMissNotices ?? false;
	}

	getUiAnimations(): boolean {
		return this.settings.uiAnimations ?? true;
	}

	setUiAnimations(enabled: boolean): Promise<void> {
		return this.commitSetting("global", "uiAnimations", enabled);
	}

	getAnimationIntensity(): AnimationIntensity {
		return this.settings.animationIntensity ?? "moderate";
	}

	setAnimationIntensity(intensity: AnimationIntensity): Promise<void> {
		return this.commitSetting("global", "animationIntensity", intensity);
	}

	getExternalEditorCommand(): string {
		const configuredEditor = this.settings.externalEditor;
		if (typeof configuredEditor === "string" && configuredEditor.trim() !== "") {
			return configuredEditor;
		}
		const environmentEditor = process.env.VISUAL || process.env.EDITOR;
		if (environmentEditor) {
			return environmentEditor;
		}
		return process.platform === "win32" ? "notepad" : "nano";
	}

	setHideThinkingBlock(hide: boolean): Promise<void> {
		return this.commitSetting("global", "hideThinkingBlock", hide);
	}

	setShowCacheMissNotices(show: boolean): Promise<void> {
		return this.commitSetting("global", "showCacheMissNotices", show);
	}

	getShellPath(): string | undefined {
		const shellPath = this.settings.shellPath;
		return shellPath ? normalizePath(shellPath) : shellPath;
	}

	setShellPath(path: string | undefined): Promise<void> {
		return this.commitSetting("global", "shellPath", path);
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): Promise<void> {
		return this.commitSetting("global", "quietStartup", quiet);
	}

	getDefaultProjectTrust(): DefaultProjectTrust {
		const value = this.globalSettings.defaultProjectTrust;
		return value === "always" || value === "never" ? value : "ask";
	}

	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): Promise<void> {
		return this.commitSetting("global", "defaultProjectTrust", defaultProjectTrust);
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): Promise<void> {
		return this.commitSetting("global", "shellCommandPrefix", prefix);
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): Promise<void> {
		return this.commitSetting("global", "npmCommand", command);
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? true;
	}

	setCollapseChangelog(collapse: boolean): Promise<void> {
		return this.commitSetting("global", "collapseChangelog", collapse);
	}

	getEnableInstallTelemetry(): boolean {
		return this.settings.enableInstallTelemetry ?? true;
	}

	setEnableInstallTelemetry(enabled: boolean): Promise<void> {
		return this.commitSetting("global", "enableInstallTelemetry", enabled);
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): Promise<void> {
		return this.commitSetting("global", "packages", packages);
	}

	setProjectPackages(packages: PackageSource[]): Promise<void> {
		return this.commitSetting("project", "packages", packages);
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): Promise<void> {
		return this.commitSetting("global", "extensions", paths);
	}

	setProjectExtensionPaths(paths: string[]): Promise<void> {
		return this.commitSetting("project", "extensions", paths);
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): Promise<void> {
		return this.commitSetting("global", "skills", paths);
	}

	setProjectSkillPaths(paths: string[]): Promise<void> {
		return this.commitSetting("project", "skills", paths);
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): Promise<void> {
		return this.commitSetting("global", "prompts", paths);
	}

	setProjectPromptTemplatePaths(paths: string[]): Promise<void> {
		return this.commitSetting("project", "prompts", paths);
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): Promise<void> {
		return this.commitSetting("global", "themes", paths);
	}

	setProjectThemePaths(paths: string[]): Promise<void> {
		return this.commitSetting("project", "themes", paths);
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): Promise<void> {
		return this.commitSetting("global", "enableSkillCommands", enabled);
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getTerminalCapabilityOverrides(): Partial<TerminalCapabilities> {
		const terminal = this.settings.terminal;
		const images = terminal?.images;
		return {
			...(images === "kitty" || images === "iterm2" ? { images } : images === false ? { images: null } : {}),
			...(typeof terminal?.trueColor === "boolean" ? { trueColor: terminal.trueColor } : {}),
			...(typeof terminal?.hyperlinks === "boolean" ? { hyperlinks: terminal.hyperlinks } : {}),
		};
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): Promise<void> {
		return this.commitTerminalSetting("showImages", show);
	}

	getImageWidthCells(): number {
		const width = this.settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return 60;
		}
		return Math.max(1, Math.floor(width));
	}

	setImageWidthCells(width: number): Promise<void> {
		return this.commitTerminalSetting("imageWidthCells", Math.max(1, Math.floor(width)));
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.CANDY_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): Promise<void> {
		return this.commitTerminalSetting("clearOnShrink", enabled);
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): Promise<void> {
		return this.commitTerminalSetting("showTerminalProgress", enabled);
	}

	getFullscreenExitOutput(): FullscreenExitOutput {
		return this.settings.fullscreenExitOutput === "resume-hint" ? "resume-hint" : "transcript";
	}

	setFullscreenExitOutput(output: FullscreenExitOutput): Promise<void> {
		return this.commitSetting("global", "fullscreenExitOutput", output);
	}

	getFullscreenScrollbar(): ScrollViewScrollbar {
		const mode = this.settings.fullscreenScrollbar;
		return mode === "always" || mode === "hidden" ? mode : "auto";
	}

	setFullscreenScrollbar(mode: ScrollViewScrollbar): Promise<void> {
		return this.commitSetting("global", "fullscreenScrollbar", mode);
	}

	getFullscreenCopyOnSelect(): boolean {
		return this.settings.fullscreenCopyOnSelect ?? true;
	}

	setFullscreenCopyOnSelect(enabled: boolean): Promise<void> {
		return this.commitSetting("global", "fullscreenCopyOnSelect", enabled);
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): Promise<void> {
		return this.commitImageSetting("autoResize", enabled);
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): Promise<void> {
		return this.commitImageSetting("blockImages", blocked);
	}

	getDefaultTools(): string[] | undefined {
		const tools = this.settings.defaultTools;
		return tools ? [...tools] : undefined;
	}

	setDefaultTools(tools: string[] | undefined): Promise<void> {
		return this.commitSetting("global", "defaultTools", tools);
	}

	getToolPreviewLines(): 5 | 10 | 20 {
		const lines = this.settings.toolPreviewLines;
		return lines === 10 || lines === 20 ? lines : 5;
	}

	setToolPreviewLines(lines: 5 | 10 | 20): Promise<void> {
		return this.commitSetting("global", "toolPreviewLines", lines);
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): Promise<void> {
		return this.commitSetting("global", "doubleEscapeAction", action);
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): Promise<void> {
		return this.commitSetting("global", "treeFilterMode", mode);
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.CANDY_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): Promise<void> {
		return this.commitSetting("global", "showHardwareCursor", enabled);
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): Promise<void> {
		return this.commitSetting("global", "editorPaddingX", Math.max(0, Math.min(3, Math.floor(padding))));
	}

	getOutputPad(): 0 | 1 {
		return this.settings.outputPad === 0 ? 0 : 1;
	}

	setOutputPad(padding: 0 | 1): Promise<void> {
		return this.commitSetting("global", "outputPad", padding);
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): Promise<void> {
		return this.commitSetting("global", "autocompleteMaxVisible", Math.max(3, Math.min(20, Math.floor(maxVisible))));
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	getMermaidRenderingMode(): MermaidRenderingMode {
		const mode = this.settings.markdown?.mermaid;
		return mode === "off" || mode === "streaming" ? mode : "final";
	}

	setMermaidRenderingMode(mode: MermaidRenderingMode): Promise<void> {
		return this.commitNestedSetting("global", "markdown", "mermaid", mode);
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): Promise<void> {
		return this.commitSetting("global", "warnings", warnings);
	}
}
