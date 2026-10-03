/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Provider } from "@candy/ai";
import type { KeyId } from "@candy/tui";
import type { createJiti } from "jiti";
import { CONFIG_DIR_NAME, getAgentDir, getPackageDir, isBunBinary, isBundledNode } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import { readCandyManifest } from "../candy-manifest.ts";
import { createEventBus, type EventBus } from "../event-bus.ts";
import type { ExecOptions } from "../exec.ts";
import { execCommand } from "../exec.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import { time } from "../timings.ts";
import type {
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionRuntime,
	LoadExtensionsResult,
	RegisteredCommand,
	ToolDefinition,
} from "./types.ts";

const require = createRequire(import.meta.url);

const isNodeSeaBinary =
	("sea" in process.features && process.features.sea === true) ||
	process.getBuiltinModule("node:sea")?.isSea() === true;
const isTypeScriptSourceRuntime = !isBunBinary && path.extname(fileURLToPath(import.meta.url)) === ".ts";
const usesEmbeddedModules = isBunBinary || isNodeSeaBinary || isBundledNode;

let createJitiPromise: Promise<typeof createJiti> | undefined;

function getCreateJiti(): Promise<typeof createJiti> {
	createJitiPromise ??= (usesEmbeddedModules ? import("./jiti-static-loader.ts") : import("./jiti-loader.ts")).then(
		(module) => module.createJiti,
	);
	return createJitiPromise;
}

/**
 * Get aliases for jiti (used in built Node.js mode).
 * In compiled binary mode, virtualModules is used instead.
 */
let _aliases: Record<string, string> | null = null;

function getAliases(): Record<string, string> {
	if (_aliases) return _aliases;

	const packageIndex = path.join(getPackageDir(), "dist", "index.js");

	const typeboxEntry = require.resolve("typebox");
	const typeboxCompileEntry = require.resolve("typebox/compile");
	const typeboxValueEntry = require.resolve("typebox/value");

	const packagesRoot = path.dirname(getPackageDir());
	const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
		const workspacePath = path.join(packagesRoot, workspaceRelativePath);
		if (fs.existsSync(workspacePath)) {
			return workspacePath;
		}
		return fileURLToPath(import.meta.resolve(specifier));
	};

	const piCodingAgentEntry = packageIndex;
	const piAgentCoreEntry = resolveWorkspaceOrImport("agent/dist/index.js", "@candy/agent-core");
	const piTuiEntry = resolveWorkspaceOrImport("tui/dist/index.js", "@candy/tui");
	const piAiEntry = resolveWorkspaceOrImport("ai/dist/index.js", "@candy/ai");
	const piAiProvidersEntry = resolveWorkspaceOrImport("ai/dist/providers/all.js", "@candy/ai/providers/all");

	_aliases = {
		"@candy/coding-agent": piCodingAgentEntry,
		"@candy/coding-agent/ui": path.join(getPackageDir(), "dist", "ui.js"),
		"@candy/coding-agent/rpc": path.join(getPackageDir(), "dist", "rpc.js"),
		"@candy/agent-core": piAgentCoreEntry,
		"@candy/tui": piTuiEntry,
		"@candy/ai/providers/all": piAiProvidersEntry,
		"@candy/ai": piAiEntry,
		typebox: typeboxEntry,
		"typebox/compile": typeboxCompileEntry,
		"typebox/value": typeboxValueEntry,
	};

	return _aliases;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

interface ExtensionCacheToken {
	cache: ExtensionModuleCache;
	generation: number;
}

export class ExtensionModuleCache {
	readonly factories = new Map<string, ExtensionFactory>();
	generation = 0;

	clear(): void {
		this.factories.clear();
		this.generation++;
	}

	token(): ExtensionCacheToken {
		return { cache: this, generation: this.generation };
	}
}

/** Create registration state that the active host binds to session actions. */
export function createExtensionRuntime(): ExtensionRuntime {
	const state: { staleMessage?: string } = {};
	const eventBusUnsubscribers = new Set<() => void>();
	const assertActive = () => {
		if (state.staleMessage) {
			throw new Error(state.staleMessage);
		}
	};
	const runtime: ExtensionRuntime = {
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		assertActive,
		invalidate: (message) => {
			if (state.staleMessage) return;
			state.staleMessage =
				message ??
				"This extension ctx is stale after session replacement or reload. Do not use a captured candy or command ctx after ctx.newSession(), ctx.fork(), ctx.clone(), ctx.switchSession(), or ctx.reload(). For newSession, fork, clone, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
			for (const unsubscribe of eventBusUnsubscribers) unsubscribe();
			eventBusUnsubscribers.clear();
		},
		trackEventBusSubscription: (unsubscribe) => {
			let active = true;
			const trackedUnsubscribe = () => {
				if (!active) return;
				active = false;
				eventBusUnsubscribers.delete(trackedUnsubscribe);
				unsubscribe();
			};
			eventBusUnsubscribers.add(trackedUnsubscribe);
			return trackedUnsubscribe;
		},
		// Providers register during setup and are installed after the model registry binds.
		registerProvider: (provider, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ provider, extensionPath });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter(
				(registration) => registration.provider.id !== name,
			);
		},
	};

	return runtime;
}

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): { api: ExtensionAPI; commit: () => void; discard: () => void } {
	const pendingFlagValues = new Map<string, boolean | string>();
	const pendingRuntimeChanges: Array<() => void> = [];
	const loadingUnsubscribers: Array<() => void> = [];
	let state: "loading" | "active" | "failed" = "loading";
	const assertActive = () => {
		if (state === "failed") {
			throw new Error(`Extension "${extension.path}" failed to load and its API is no longer active.`);
		}
		runtime.assertActive();
	};
	const getActions = () => {
		assertActive();
		if (!runtime.actions) throw new Error("Extension actions are unavailable until the host binds the session.");
		return runtime.actions;
	};
	const applyRuntimeChange = (change: () => void) => {
		if (state === "loading") pendingRuntimeChanges.push(change);
		else change();
	};
	const clearPending = () => {
		pendingFlagValues.clear();
		pendingRuntimeChanges.length = 0;
		loadingUnsubscribers.length = 0;
	};

	const api = {
		// Registration methods - write to extension
		on(event: string, handler: HandlerFn): () => void {
			assertActive();
			const registeredHandler: HandlerFn = (...args) => handler(...args);
			const list = extension.handlers.get(event) ?? [];
			list.push(registeredHandler);
			extension.handlers.set(event, list);

			return () => {
				const handlers = extension.handlers.get(event);
				if (!handlers) return;
				const handlerIndex = handlers.indexOf(registeredHandler);
				if (handlerIndex === -1) return;
				handlers.splice(handlerIndex, 1);
				if (handlers.length === 0) extension.handlers.delete(event);
			};
		},

		registerTool(tool: ToolDefinition): void {
			assertActive();
			if (typeof tool.parameters !== "object" || tool.parameters === null || Array.isArray(tool.parameters)) {
				throw new Error(
					`Tool "${tool.name}" registered by extension "${extension.path}" must define an object parameter schema.`,
				);
			}
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
			});
			runtime.actions?.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			assertActive();
			if (typeof name !== "string" || name.length === 0) {
				throw new Error(
					`Command registered by extension "${extension.path}" must have a non-empty string name. Use candy.registerCommand("name", { description, handler }).`,
				);
			}
			if (typeof options?.handler !== "function") {
				throw new Error(`Command "/${name}" registered by extension "${extension.path}" must define handler().`);
			}
			extension.commands.set(name, {
				name,
				sourceInfo: extension.sourceInfo,
				...options,
			});
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: import("./types.ts").ExtensionContext) => Promise<void> | void;
			},
		): void {
			assertActive();
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			assertActive();
			if (options.default !== undefined && typeof options.default !== options.type) {
				throw new Error(
					`Invalid default for flag "${name}": expected ${options.type}, got ${typeof options.default}`,
				);
			}
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				if (state === "loading") {
					if (!pendingFlagValues.has(name)) pendingFlagValues.set(name, options.default);
				} else {
					runtime.flagValues.set(name, options.default);
				}
			}
		},

		// Flag access - checks extension registered it, reads from runtime
		getFlag(name: string): boolean | string | undefined {
			assertActive();
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.has(name) ? runtime.flagValues.get(name) : pendingFlagValues.get(name);
		},

		// Action methods - delegate to shared runtime
		sendMessage(message, options): void {
			assertActive();
			getActions().sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			assertActive();
			getActions().sendUserMessage(content, options);
		},

		appendEntry(customType: string, data?: unknown): void {
			assertActive();
			getActions().appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			assertActive();
			getActions().setSessionName(name);
		},

		getSessionName(): string | undefined {
			assertActive();
			return getActions().getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			assertActive();
			getActions().setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			assertActive();
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			assertActive();
			return getActions().getActiveTools();
		},

		getAllTools() {
			assertActive();
			return getActions().getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			assertActive();
			getActions().setActiveTools(toolNames);
		},

		getCommands() {
			assertActive();
			return getActions().getCommands();
		},

		setModel(model) {
			assertActive();
			return getActions().setModel(model);
		},

		getThinkingLevel() {
			assertActive();
			return getActions().getThinkingLevel();
		},

		setThinkingLevel(level) {
			assertActive();
			getActions().setThinkingLevel(level);
		},

		registerProvider(provider: Provider) {
			assertActive();
			applyRuntimeChange(() => runtime.registerProvider(provider, extension.path));
		},

		unregisterProvider(name: string) {
			assertActive();
			applyRuntimeChange(() => runtime.unregisterProvider(name, extension.path));
		},

		events: {
			emit(channel, data) {
				assertActive();
				eventBus.emit(channel, data);
			},
			on(channel, handler) {
				assertActive();
				const unsubscribe = runtime.trackEventBusSubscription(eventBus.on(channel, handler));
				if (state === "loading") loadingUnsubscribers.push(unsubscribe);
				return unsubscribe;
			},
		},
	} as ExtensionAPI;

	return {
		api,
		commit: () => {
			if (state !== "loading") return;
			runtime.assertActive();
			for (const [name, value] of pendingFlagValues) {
				if (!runtime.flagValues.has(name)) runtime.flagValues.set(name, value);
			}
			for (const apply of pendingRuntimeChanges) apply();
			state = "active";
			clearPending();
		},
		discard: () => {
			if (state !== "loading") return;
			state = "failed";
			for (const unsubscribe of loadingUnsubscribers) unsubscribe();
			clearPending();
		},
	};
}

function isCurrentCacheToken(cacheToken: ExtensionCacheToken | undefined): cacheToken is ExtensionCacheToken {
	return cacheToken !== undefined && cacheToken.cache.generation === cacheToken.generation;
}

async function loadExtensionModule(
	extensionPath: string,
	extensionModules: Record<string, unknown> | undefined,
	cacheToken?: ExtensionCacheToken,
) {
	if (isCurrentCacheToken(cacheToken)) {
		const cachedFactory = cacheToken.cache.factories.get(extensionPath);
		if (cachedFactory) {
			return cachedFactory;
		}
	}

	const createJitiImpl = await getCreateJiti();
	// Compiled binaries and the bundled Node distribution use embedded modules.
	// Source TypeScript reuses host modules and root tsconfig paths. Unbundled
	// Node builds use dist aliases and do not need the bundled virtual modules.
	const resolutionOptions = usesEmbeddedModules
		? { virtualModules: requireExtensionModules(extensionModules), tryNative: false }
		: isTypeScriptSourceRuntime
			? { virtualModules: requireExtensionModules(extensionModules), tsconfigPaths: true }
			: { alias: getAliases() };
	const jiti = createJitiImpl(import.meta.url, {
		moduleCache: false,
		...resolutionOptions,
	});

	const module = await jiti.import(extensionPath, { default: true });
	const factory = module as ExtensionFactory;
	if (typeof factory !== "function") {
		return undefined;
	}
	if (isCurrentCacheToken(cacheToken)) {
		cacheToken.cache.factories.set(extensionPath, factory);
	}
	return factory;
}

function requireExtensionModules(extensionModules: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!extensionModules) {
		throw new Error("Extension module map is required when loading source or embedded extensions");
	}
	return extensionModules;
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	const source =
		extensionPath.startsWith("<") && extensionPath.endsWith(">")
			? extensionPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";
	const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

	return {
		path: extensionPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
		handlers: new Map(),
		tools: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

async function initializeExtension(
	factory: ExtensionFactory,
	extensionPath: string,
	resolvedPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
): Promise<Extension> {
	const extension = createExtension(extensionPath, resolvedPath);
	const load = createExtensionAPI(extension, runtime, cwd, eventBus);
	try {
		await factory(load.api);
		load.commit();
	} catch (error) {
		load.discard();
		throw error;
	}
	time(`${extensionPath} factory`, "extensions");
	return extension;
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionModules: Record<string, unknown> | undefined,
	cacheToken?: ExtensionCacheToken,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });

	try {
		const factory = await loadExtensionModule(resolvedPath, extensionModules, cacheToken);
		time(`${extensionPath} module import`, "extensions");
		if (!factory) {
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		const extension = await initializeExtension(factory, extensionPath, resolvedPath, cwd, eventBus, runtime);

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
): Promise<Extension> {
	const resolvedCwd = resolvePath(cwd);
	return initializeExtension(factory, extensionPath, extensionPath, resolvedCwd, eventBus, runtime);
}

/**
 * Load extensions from paths.
 */
async function loadExtensionsInternal(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
	extensionModules?: Record<string, unknown>,
	cache?: ExtensionModuleCache,
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const warnings: Array<{ path: string; warning: string }> = [];
	const cacheToken = cache?.token();
	const resolvedCwd = resolvePath(cwd);
	const resolvedEventBus = eventBus ?? createEventBus();
	const resolvedRuntime = runtime ?? createExtensionRuntime();

	for (const extPath of paths) {
		const { extension, error } = await loadExtension(
			extPath,
			resolvedCwd,
			resolvedEventBus,
			resolvedRuntime,
			extensionModules,
			cacheToken,
		);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		warnings,
		runtime: resolvedRuntime,
	};
}

export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
	extensionModules?: Record<string, unknown>,
): Promise<LoadExtensionsResult> {
	return loadExtensionsInternal(paths, cwd, eventBus, runtime, extensionModules);
}

export async function loadExtensionsCached(
	cache: ExtensionModuleCache,
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
	extensionModules?: Record<string, unknown>,
): Promise<LoadExtensionsResult> {
	return loadExtensionsInternal(paths, cwd, eventBus, runtime, extensionModules, cache);
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "pi.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir: string): string[] | null {
	// Check for package.json with "candy" field first
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readCandyManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = path.resolve(dir, extPath);
				if (fs.existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	// Check for index.ts or index.js
	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "candy" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			// 1. Direct files: *.ts or *.js
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				discovered.push(entryPath);
				continue;
			}

			// 2 & 3. Subdirectories
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const entries = resolveExtensionEntries(entryPath);
				if (entries) {
					discovered.push(...entries);
				}
			}
		}
	} catch {
		return [];
	}

	return discovered;
}

/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	eventBus?: EventBus,
	extensionModules?: Record<string, unknown>,
): Promise<LoadExtensionsResult> {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const allPaths: string[] = [];
	const seen = new Set<string>();

	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. Project-local extensions: cwd/${CONFIG_DIR_NAME}/extensions/
	const localExtDir = path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions");
	addPaths(discoverExtensionsInDir(localExtDir));

	// 2. Global extensions: agentDir/extensions/
	const globalExtDir = path.join(resolvedAgentDir, "extensions");
	addPaths(discoverExtensionsInDir(globalExtDir));

	// 3. Explicitly configured paths
	for (const p of configuredPaths) {
		const resolved = resolvePath(p, resolvedCwd, { normalizeUnicodeSpaces: true });
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			// Check for package.json with candy manifest or index.ts
			const entries = resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}
			// No explicit entries - discover individual files in directory
			addPaths(discoverExtensionsInDir(resolved));
			continue;
		}

		addPaths([resolved]);
	}

	return loadExtensions(allPaths, resolvedCwd, eventBus, undefined, extensionModules);
}
