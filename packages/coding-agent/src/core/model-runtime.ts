import { dirname, join } from "node:path";
import {
	type AnyModel,
	type Api,
	type AssistantImages,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthOperationOptions,
	type AuthResult,
	type AuthType,
	type Context,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createModels,
	type DeferredHandle,
	type ImageApi,
	type ImageModel,
	type ImagesContext,
	InMemoryModelsStore,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	type ModelsDeferredCancelOptions,
	type ModelsDeferredFetchOptions,
	type ModelsImagesOptions,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsSimpleStreamOptions,
	type ModelsStore,
	type ModelType,
	type ModelTypeMap,
	type MutableModels,
	type Provider,
} from "@candy/ai";
import * as builtinProviderCatalog from "@candy/ai/providers/all";
import { isAbortError, operationSignal, raceWithAbortSignal } from "@candy/ai/utils/abort";
import { getAgentDir } from "../config.ts";
import { AuthStorage as DefaultAuthStorage } from "./auth-storage.ts";
import { ModelConfig } from "./model-config.ts";
import { FileModelsStore } from "./models-store.ts";
import {
	type AuthStatus,
	composeModelProvider,
	configuredRequestAuthStatus,
	resolveConfiguredModelHeaders,
} from "./provider-composer.ts";
import { RuntimeCredentials } from "./runtime-credentials.ts";

interface ModelRuntimeSnapshot {
	all: readonly Model<Api>[];
	available: readonly Model<Api>[];
	configuredProviders: ReadonlySet<string>;
	storedProviders: ReadonlySet<string>;
	auth: ReadonlyMap<string, AuthCheck | undefined>;
}

export interface CreateModelRuntimeOptions {
	/** Credential storage. Defaults to the file at authPath. */
	credentials?: CredentialStore;
	authPath?: string;
	modelsPath?: string | null;
	modelsStore?: ModelsStore;
	modelsStorePath?: string;
	/** Allow create() to refresh model catalogs over the network. Defaults to false. */
	allowModelNetwork?: boolean;
	/** Timeout for the create-time network model refresh. */
	modelRefreshTimeoutMs?: number;
	/** Optional caller cancellation for initial cache restoration and availability checks. */
	signal?: AbortSignal;
	/** Skip initial catalog and availability refresh. Static models remain available. */
	refreshOnCreate?: boolean;
}

export interface ModelRuntimeAuthOverrides extends AuthOperationOptions {
	apiKey?: string;
	env?: Record<string, string>;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	minOAuthValidityMs?: number;
}

export type CredentialSynchronizationOperation = "login" | "logout" | "setRuntimeApiKey" | "removeRuntimeApiKey";

/** Credentials changed successfully, but the local model/auth snapshot could not be synchronized. */
export class CredentialSynchronizationError extends Error {
	readonly providerId: string;
	readonly operation: CredentialSynchronizationOperation;
	readonly credential: Credential | undefined;

	constructor(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		options: ErrorOptions,
	) {
		super(`Credential ${operation} committed for ${providerId}, but local synchronization failed`, options);
		this.name = "CredentialSynchronizationError";
		this.providerId = providerId;
		this.operation = operation;
		this.credential = credential;
	}
}

/** Configured Models collection used by coding-agent and SDK consumers. */
export class ModelRuntime implements Models {
	private readonly models: MutableModels;
	private readonly credentials: RuntimeCredentials;
	private readonly defaultBuiltins: ReadonlyMap<string, Provider>;
	private readonly builtins = new Map<string, Provider>();
	private readonly nativeExtensionProviders = new Map<string, Provider>();
	private readonly compositionErrors = new Map<string, string>();
	private readonly modelsPath: string | undefined;
	private readonly modelNetworkEnabled: boolean;
	private config: ModelConfig;
	private snapshot: ModelRuntimeSnapshot = {
		all: [],
		available: [],
		configuredProviders: new Set(),
		storedProviders: new Set(),
		auth: new Map(),
	};
	private availabilityRefreshSeq = 0;
	private availabilityErrorSeq = 0;
	private readonly providerAvailabilitySeq = new Map<string, number>();
	private availabilityError: string | undefined;
	private readonly credentialOperations = new Map<string, Promise<unknown>>();
	private readonly commandCache = new Map<string, string>();
	private readonly lifetime = new AbortController();
	private readonly activeWork = new Set<Promise<unknown>>();
	private disposePromise?: Promise<void>;
	private disposed = false;
	private readonly activeCatalogRefreshes = new Map<
		string,
		{ controller: AbortController; promise: Promise<ModelsRefreshResult>; waiters: number }
	>();

	private assertActive(): void {
		if (this.disposed) throw new Error("Model runtime is disposed");
	}

	private operationSignal(signal?: AbortSignal): AbortSignal {
		this.assertActive();
		return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
	}

	private trackWithSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
		const guarded = signal
			? work.then(
					(value) => {
						signal.throwIfAborted();
						return value;
					},
					(error: unknown) => {
						signal.throwIfAborted();
						throw error;
					},
				)
			: work;
		let tracked!: Promise<T>;
		tracked = guarded.finally(() => this.activeWork.delete(tracked));
		this.activeWork.add(tracked);
		return tracked;
	}

	private constructor(
		credentials: RuntimeCredentials,
		config: ModelConfig,
		modelsPath: string | undefined,
		modelsStore: ModelsStore,
		providers: readonly Provider[],
		modelNetworkEnabled: boolean,
	) {
		this.credentials = credentials;
		this.config = config;
		this.modelsPath = modelsPath;
		this.modelNetworkEnabled = modelNetworkEnabled;
		this.defaultBuiltins = new Map(providers.map((provider) => [provider.id, provider]));
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		this.models = createModels({
			credentials,
			modelsStore,
			decorateAuth: async (model, resolution, options) => {
				if (!resolution) return undefined;
				return resolveConfiguredModelHeaders(model, this.config.getProvider(model.provider), resolution.env, {
					signal: options.signal,
					cache: this.commandCache,
				});
			},
		});
		this.rebuildProviders();
	}

	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		const credentials = new RuntimeCredentials(options.credentials ?? DefaultAuthStorage.create(options.authPath));
		const modelsPath =
			options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
		const config = await ModelConfig.load(modelsPath);
		const modelsStore =
			options.modelsStore ??
			(modelsPath
				? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
				: new InMemoryModelsStore());
		const providers = builtinProviderCatalog.builtinProviders();
		const runtime = new ModelRuntime(
			credentials,
			config,
			modelsPath,
			modelsStore,
			providers,
			process.env.CANDY_OFFLINE === undefined,
		);
		const refreshFromNetwork = runtime.modelNetworkEnabled && options.allowModelNetwork === true;
		const controller =
			refreshFromNetwork && options.modelRefreshTimeoutMs !== undefined ? new AbortController() : undefined;
		const timeout = controller ? setTimeout(() => controller.abort(), options.modelRefreshTimeoutMs) : undefined;
		const signal = controller
			? options.signal
				? AbortSignal.any([options.signal, controller.signal])
				: controller.signal
			: options.signal;
		try {
			if (options.refreshOnCreate !== false) {
				await runtime.refresh({ allowNetwork: refreshFromNetwork, signal });
			}
		} catch (error) {
			try {
				await runtime.dispose();
			} catch (disposeError) {
				throw new AggregateError([error, disposeError], "Model runtime creation and cleanup failed");
			}
			throw error;
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		return runtime;
	}

	private providerIds(): Set<string> {
		return new Set([
			...this.builtins.keys(),
			...this.nativeExtensionProviders.keys(),
			...this.config.getProviderIds(),
		]);
	}

	private recomposeProvider(providerId: string): void {
		const base = this.nativeExtensionProviders.get(providerId) ?? this.builtins.get(providerId);
		if (!base && !this.config.getProvider(providerId)) {
			this.models.deleteProvider(providerId);
			this.compositionErrors.delete(providerId);
			return;
		}
		if (base && !this.config.getProvider(providerId)) {
			// No overlays: use the builtin untouched so its auth/login/stream behavior is exact.
			this.models.setProvider(base);
			this.compositionErrors.delete(providerId);
			return;
		}
		try {
			this.models.setProvider(composeModelProvider(providerId, base, this.config, this.commandCache));
			this.compositionErrors.delete(providerId);
		} catch (error) {
			this.compositionErrors.set(providerId, error instanceof Error ? error.message : String(error));
			this.models.deleteProvider(providerId);
		}
	}

	private rebuildProviders(): void {
		this.models.clearProviders();
		this.compositionErrors.clear();
		for (const providerId of this.providerIds()) this.recomposeProvider(providerId);
		this.updateModelSnapshot();
	}

	private updateModelSnapshot(): void {
		const all = [...this.models.getModels()];
		this.snapshot = {
			...this.snapshot,
			all,
			available: all.filter((model) => this.snapshot.configuredProviders.has(model.provider)),
		};
	}

	private async runAvailabilityRefresh(seq: number, errorSeq: number, signal: AbortSignal): Promise<void> {
		const availability = await this.models.getAvailability(undefined, { signal });
		signal.throwIfAborted();
		if (seq !== this.availabilityRefreshSeq) return;
		const auth = new Map(availability.providers.map(({ providerId, auth }) => [providerId, auth]));
		const configuredProviders = new Set(
			availability.providers.filter(({ auth }) => auth !== undefined).map(({ providerId }) => providerId),
		);
		this.snapshot = {
			all: [...this.models.getModels()],
			available: [...availability.available],
			configuredProviders,
			storedProviders: new Set(availability.credentialProviderIds),
			auth,
		};
		if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
	}

	private queueAvailabilityRefresh(signal?: AbortSignal): Promise<void> {
		const seq = ++this.availabilityRefreshSeq;
		for (const [providerId, providerSeq] of this.providerAvailabilitySeq) {
			this.providerAvailabilitySeq.set(providerId, providerSeq + 1);
		}
		const errorSeq = ++this.availabilityErrorSeq;
		const effectiveSignal = operationSignal(signal);
		return this.runAvailabilityRefresh(seq, errorSeq, effectiveSignal).catch((error) => {
			if (errorSeq === this.availabilityErrorSeq && !effectiveSignal.aborted) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		});
	}

	private async refreshProviderAvailability(providerId: string, signal: AbortSignal): Promise<void> {
		// Invalidate any full availability pass that started before this credential change.
		++this.availabilityRefreshSeq;
		const providerSeq = (this.providerAvailabilitySeq.get(providerId) ?? 0) + 1;
		this.providerAvailabilitySeq.set(providerId, providerSeq);
		const errorSeq = ++this.availabilityErrorSeq;
		try {
			const availability = await this.models.getAvailability(providerId, { signal });
			signal.throwIfAborted();
			if (this.providerAvailabilitySeq.get(providerId) !== providerSeq) return;
			const provider = availability.providers.find((entry) => entry.providerId === providerId);
			const auth = provider?.auth;
			const configuredProviders = new Set(this.snapshot.configuredProviders);
			const storedProviders = new Set(this.snapshot.storedProviders);
			const authByProvider = new Map(this.snapshot.auth);
			if (auth) {
				configuredProviders.add(providerId);
				authByProvider.set(providerId, auth);
			} else {
				configuredProviders.delete(providerId);
				authByProvider.delete(providerId);
			}
			storedProviders.clear();
			for (const storedProviderId of availability.credentialProviderIds) storedProviders.add(storedProviderId);
			const all = [...this.models.getModels()];
			const availableById = new Map(
				[
					...this.snapshot.available.filter((model) => model.provider !== providerId),
					...availability.available,
				].map((model) => [`${model.provider}\0${model.id}`, model]),
			);
			this.snapshot = {
				all,
				available: all.flatMap((model) => availableById.get(`${model.provider}\0${model.id}`) ?? []),
				configuredProviders,
				storedProviders,
				auth: authByProvider,
			};
			if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
		} catch (error) {
			if (
				this.providerAvailabilitySeq.get(providerId) === providerSeq &&
				errorSeq === this.availabilityErrorSeq &&
				!signal.aborted
			) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		}
	}

	getProviders(): readonly Provider[] {
		return this.models.getProviders();
	}

	getProvider(providerId: string): Provider | undefined {
		return this.models.getProvider(providerId);
	}

	getModels(providerId?: string): readonly Model<Api>[] {
		return this.models.getModels(providerId);
	}

	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.models.getModel(providerId, modelId);
	}

	getModelsOfType<TType extends ModelType>(type: TType, providerId?: string): readonly ModelTypeMap[TType][] {
		return this.models.getModelsOfType(type, providerId);
	}

	getModelOfType<TType extends ModelType>(
		type: TType,
		providerId: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		return this.models.getModelOfType(type, providerId, modelId);
	}

	getAllModels(providerId?: string): readonly AnyModel[] {
		return this.models.getAllModels(providerId);
	}

	getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		const signal = this.operationSignal(options?.signal);
		return this.trackWithSignal(this.models.getAvailableOfType(type, providerId, { ...options, signal }), signal);
	}

	getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		const signal = this.operationSignal(options?.signal);
		return this.trackWithSignal(this.models.getAllAvailable(providerId, { ...options, signal }), signal);
	}

	getAvailability(providerId?: string, options?: AuthOperationOptions) {
		const signal = this.operationSignal(options?.signal);
		return this.trackWithSignal(this.models.getAvailability(providerId, { ...options, signal }), signal);
	}

	async checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		const signal = this.operationSignal(options?.signal);
		const availability = await this.trackWithSignal(
			this.models.getAvailability(providerId, {
				...options,
				signal,
			}),
			signal,
		);
		return availability.providers.find((provider) => provider.providerId === providerId)?.auth;
	}

	getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		const signal = this.operationSignal(options?.signal);
		return this.trackWithSignal(
			(async () => {
				if (providerId) {
					const errorSeq = ++this.availabilityErrorSeq;
					try {
						const available = (await this.models.getAvailability(providerId, { ...options, signal })).available;
						if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
						return available;
					} catch (error) {
						if (errorSeq === this.availabilityErrorSeq && !signal.aborted) {
							this.availabilityError = error instanceof Error ? error.message : String(error);
						}
						throw error;
					}
				}
				await this.queueAvailabilityRefresh(signal);
				return this.snapshot.available;
			})(),
			signal,
		);
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.snapshot.available;
	}

	getError(): string | undefined {
		const errors: string[] = [];
		const configError = this.config.getError();
		if (configError) errors.push(configError);
		for (const [providerId, error] of this.compositionErrors) {
			errors.push(`Provider "${providerId}": ${error}`);
		}
		if (this.availabilityError) errors.push(`Availability refresh: ${this.availabilityError}`);
		return errors.length > 0 ? errors.join("\n\n") : undefined;
	}

	getRegisteredProviderIds(): readonly string[] {
		return [...this.nativeExtensionProviders.keys()];
	}

	getRegisteredNativeProvider(providerId: string): Provider | undefined {
		return this.nativeExtensionProviders.get(providerId);
	}

	isUsingOAuth(providerId: string): boolean {
		return this.snapshot.auth.get(providerId)?.type === "oauth";
	}

	isUsingSubscription(providerId: string): boolean {
		return this.isUsingOAuth(providerId) && this.models.getProvider(providerId)?.auth.oauth?.isSubscription === true;
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.snapshot.configuredProviders.has(providerId);
	}

	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: AnyModel, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | AnyModel,
		overrides: ModelRuntimeAuthOverrides = {},
	): Promise<AuthResult | undefined> {
		const operationOptions = { ...overrides, signal: this.operationSignal(overrides.signal) };
		if (typeof providerOrModel === "string") {
			return this.trackWithSignal(this.models.getAuth(providerOrModel, operationOptions), operationOptions.signal);
		}
		return this.trackWithSignal(this.models.getAuth(providerOrModel, operationOptions), operationOptions.signal);
	}

	private enqueueCredentialOperation<T>(providerId: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
		this.assertActive();
		signal = this.operationSignal(signal);
		const previous = this.credentialOperations.get(providerId) ?? Promise.resolve();
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const operation = (async () => {
			await previous.catch(() => {});
			signal.throwIfAborted();
			markStarted?.();
			return task();
		})();
		const tail = operation.catch(() => {});
		this.credentialOperations.set(providerId, tail);
		void tail.then(() => {
			if (this.credentialOperations.get(providerId) === tail) this.credentialOperations.delete(providerId);
		});
		return raceWithAbortSignal(started, signal).then(() => operation);
	}

	private async synchronizeCredentialState(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		signal: AbortSignal,
	): Promise<void> {
		try {
			this.commandCache.clear();
			signal.throwIfAborted();
			this.recomposeProvider(providerId);
			const compositionError = this.compositionErrors.get(providerId);
			if (compositionError) throw new Error(compositionError);
			const result = await this.models.refresh({ allowNetwork: false, providers: [providerId], signal });
			if (result.aborted) signal.throwIfAborted();
			const refreshError = result.errors.get(providerId);
			if (refreshError) throw refreshError;
			this.updateModelSnapshot();
			await this.refreshProviderAvailability(providerId, signal);
		} catch (cause) {
			throw new CredentialSynchronizationError(providerId, operation, credential, { cause });
		}
	}

	setRuntimeApiKey(providerId: string, apiKey: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = this.operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			this.credentials.setRuntimeApiKey(providerId, apiKey);
			await this.synchronizeCredentialState(
				providerId,
				"setRuntimeApiKey",
				{ type: "api_key", key: apiKey },
				signal,
			);
		});
	}

	removeRuntimeApiKey(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = this.operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			this.credentials.removeRuntimeApiKey(providerId);
			await this.synchronizeCredentialState(providerId, "removeRuntimeApiKey", undefined, signal);
		});
	}

	listCredentials(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const signal = this.operationSignal(options?.signal);
		return this.trackWithSignal(this.credentials.list({ ...options, signal }), signal);
	}

	getProviderAuthStatus(providerId: string): AuthStatus {
		if (this.credentials.hasRuntimeApiKey(providerId)) return { configured: true, source: "runtime" };
		if (this.snapshot.storedProviders.has(providerId)) return { configured: true, source: "stored" };
		const configured = configuredRequestAuthStatus(this.config.getProvider(providerId));
		if (configured) return configured;
		const check = this.snapshot.auth.get(providerId);
		return check ? { configured: true, source: "environment", label: check.source } : { configured: false };
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		this.assertActive();
		return this.models.stream(model, context, options);
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		this.assertActive();
		return this.models.complete(model, context, options);
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return this.models.streamSimple(model, context, { ...options, signal: this.operationSignal(options?.signal) });
	}

	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.models.completeSimple(model, context, { ...options, signal: this.operationSignal(options?.signal) });
	}

	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream {
		return this.models.streamDeferred(model, handle, { ...options, signal: this.operationSignal(options?.signal) });
	}

	fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return this.models.fetchDeferred(model, handle, { ...options, signal: this.operationSignal(options?.signal) });
	}

	async cancelDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredCancelOptions,
	): Promise<void> {
		await this.models.cancelDeferred(model, handle, { ...options, signal: this.operationSignal(options?.signal) });
	}

	generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		return this.models.generateImages(model, context, { ...options, signal: this.operationSignal(options?.signal) });
	}

	login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		const signal = this.operationSignal(interaction.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			const credential = await this.models.login(providerId, type, { ...interaction, signal });
			await this.synchronizeCredentialState(providerId, "login", credential, signal);
			return credential;
		});
	}

	logout(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = this.operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			await this.models.logout(providerId, { signal });
			await this.synchronizeCredentialState(providerId, "logout", undefined, signal);
		});
	}

	refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const callerSignal = this.operationSignal(options.signal);
		callerSignal.throwIfAborted();
		const allowNetwork = options.allowNetwork ?? this.modelNetworkEnabled;
		const providers = options.providers ? [...new Set(options.providers)].sort() : undefined;
		const key = JSON.stringify([allowNetwork, options.force ?? false, providers ?? null]);
		let active = this.activeCatalogRefreshes.get(key);
		if (!active) {
			const controller = new AbortController();
			let promise!: Promise<ModelsRefreshResult>;
			promise = this.runRefresh({ ...options, providers, allowNetwork, signal: controller.signal }).finally(() => {
				if (this.activeCatalogRefreshes.get(key)?.promise === promise) this.activeCatalogRefreshes.delete(key);
			});
			active = { controller, promise, waiters: 0 };
			this.activeCatalogRefreshes.set(key, active);
		}
		active.waiters++;
		return raceWithAbortSignal(active.promise, callerSignal)
			.catch((error: unknown) => {
				if (callerSignal.aborted) return { aborted: true, errors: new Map() };
				throw error;
			})
			.finally(() => {
				active!.waiters--;
				if (active!.waiters === 0 && this.activeCatalogRefreshes.get(key) === active) active!.controller.abort();
			});
	}

	private async runRefresh(options: ModelsRefreshOptions & { allowNetwork: boolean }): Promise<ModelsRefreshResult> {
		this.commandCache.clear();
		this.config = await ModelConfig.load(this.modelsPath);
		options.signal?.throwIfAborted();
		if (options.providers) {
			for (const providerId of new Set(options.providers)) this.recomposeProvider(providerId);
			this.updateModelSnapshot();
		} else {
			this.rebuildProviders();
		}
		const refreshOptions = {
			...options,
			allowNetwork: options.allowNetwork ?? this.modelNetworkEnabled,
		};
		const result = await this.models.refresh(refreshOptions);
		options.signal?.throwIfAborted();
		const errors = new Map(result.errors);
		this.updateModelSnapshot();
		if (options.providers) {
			await Promise.all(
				[...new Set(options.providers)].map(async (providerId) => {
					try {
						await this.refreshProviderAvailability(providerId, operationSignal(options.signal));
					} catch (error) {
						if (!options.signal?.aborted) {
							errors.set(providerId, error instanceof Error ? error : new Error(String(error)));
						}
					}
				}),
			);
		} else {
			try {
				await this.queueAvailabilityRefresh(options.signal);
			} catch (error) {
				if (!options.signal?.aborted) {
					errors.set("$availability", error instanceof Error ? error : new Error(String(error)));
				}
			}
		}
		return { aborted: result.aborted || (options.signal?.aborted ?? false), errors };
	}

	registerNativeProvider(provider: Provider): void {
		this.assertActive();
		if (!provider.id.trim()) throw new Error("Provider id must not be empty.");
		this.commandCache.clear();
		this.nativeExtensionProviders.set(provider.id, provider);
		this.recomposeProvider(provider.id);
		this.updateModelSnapshot();
	}

	unregisterProvider(providerId: string): void {
		this.assertActive();
		this.commandCache.clear();
		this.nativeExtensionProviders.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
	}

	dispose(): Promise<void> {
		this.disposePromise ??= (async () => {
			if (!this.disposed) {
				this.disposed = true;
				this.lifetime.abort(new DOMException("Model runtime disposed", "AbortError"));
				for (const refresh of this.activeCatalogRefreshes.values()) refresh.controller.abort();
			}
			const settlements = await Promise.allSettled([
				...Array.from(this.activeCatalogRefreshes.values(), ({ promise }) => promise),
				...this.credentialOperations.values(),
				...this.activeWork,
			]);
			this.commandCache.clear();
			const errors = settlements.flatMap((settlement) =>
				settlement.status === "rejected" && !isAbortError(settlement.reason) ? [settlement.reason] : [],
			);
			if (errors.length) throw new AggregateError(errors, "Model runtime disposal failed");
		})();
		return this.disposePromise;
	}
}
