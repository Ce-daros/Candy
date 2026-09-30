import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type * as undiciTypes from "undici";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
// Node's 250ms default can terminate valid connection attempts on high-latency routes.
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;
const loadUndici = createRequire(import.meta.url);
const undiciRuntime = process.versions.bun === undefined ? (loadUndici("undici") as typeof undiciTypes) : undefined;

type BunFetchInit = RequestInit & {
	timeout?: number | false;
	proxy?: false | { url: string; respectNoProxy: boolean };
};

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// prevents EventEmitter's unhandled "error" special case from crashing Candy.
function withUndiciErrorListener<T extends undiciTypes.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undiciTypes.Dispatcher {
	if (!undiciRuntime) throw new Error("Undici dispatchers are unavailable in Bun");
	return withUndiciErrorListener(new undiciRuntime.Client(origin, options as undiciTypes.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undiciTypes.Dispatcher {
	if (!undiciRuntime) throw new Error("Undici dispatchers are unavailable in Bun");
	const dispatcherOptions = options as undiciTypes.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undiciRuntime.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

function createHttpDispatcher(settings: HttpDispatcherSettings): undiciTypes.Dispatcher {
	if (!undiciRuntime) throw new Error("Undici dispatchers are unavailable in Bun");
	const timeoutMs = settings.timeoutMs ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	return withUndiciErrorListener(
		new undiciRuntime.EnvHttpProxyAgent({
			httpProxy: process.env.HTTP_PROXY ?? (settings.httpProxy?.trim() || undefined),
			httpsProxy: process.env.HTTPS_PROXY ?? (settings.httpProxy?.trim() || undefined),
			noProxy: process.env.NO_PROXY ?? process.env.no_proxy,
			allowH2: false,
			// Keep HTTP origins on CONNECT tunnels as they were before Undici 8.7.
			proxyTunnel: true,
			bodyTimeout: normalizedTimeoutMs,
			connect: {
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			},
			headersTimeout: normalizedTimeoutMs,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
}

export interface HttpDispatcherSettings {
	timeoutMs?: number;
	httpProxy?: string;
}

/** Configures the process-wide HTTP transport for Node or Bun. */
export class HttpDispatcherHost {
	private readonly originalDispatcher: undiciTypes.Dispatcher | undefined;
	private ownedDispatcher: undiciTypes.Dispatcher | undefined;
	private originalFetch: typeof globalThis.fetch | undefined;
	private bunFetchWrapper: typeof globalThis.fetch | undefined;
	private bunSettings: HttpDispatcherSettings | undefined;
	private installedNoProxy: string | undefined;
	private disposed = false;

	constructor() {
		this.originalDispatcher = undiciRuntime?.getGlobalDispatcher();
	}

	async configure(settings: HttpDispatcherSettings = {}): Promise<void> {
		if (this.disposed) throw new Error("HTTP dispatcher host has been disposed");
		if (!undiciRuntime) {
			const timeoutMs = parseHttpIdleTimeoutMs(settings.timeoutMs ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS);
			if (timeoutMs === undefined) throw new Error(`Invalid HTTP idle timeout: ${String(settings.timeoutMs)}`);
			if (process.env.NO_PROXY === undefined && process.env.no_proxy !== undefined) {
				process.env.NO_PROXY = process.env.no_proxy;
				this.installedNoProxy = process.env.NO_PROXY;
			} else if (this.installedNoProxy !== undefined && process.env.NO_PROXY === this.installedNoProxy) {
				if (process.env.no_proxy === undefined) {
					delete process.env.NO_PROXY;
					this.installedNoProxy = undefined;
				} else if (process.env.no_proxy !== this.installedNoProxy) {
					process.env.NO_PROXY = process.env.no_proxy;
					this.installedNoProxy = process.env.NO_PROXY;
				}
			}
			if (!this.bunFetchWrapper) {
				this.originalFetch = globalThis.fetch;
				const originalFetch = this.originalFetch;
				this.bunFetchWrapper = async (input, init) => {
					const url = input instanceof Request ? new URL(input.url) : new URL(input);
					const proxy =
						url.protocol === "http:"
							? (process.env.HTTP_PROXY ?? this.bunSettings?.httpProxy?.trim())
							: (process.env.HTTPS_PROXY ?? this.bunSettings?.httpProxy?.trim());
					const options: BunFetchInit = {
						...init,
						timeout:
							this.bunSettings?.timeoutMs === 0
								? false
								: (this.bunSettings?.timeoutMs ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS),
						...(proxy ? { proxy: { url: proxy, respectNoProxy: true } } : {}),
					};
					return originalFetch(input, options);
				};
				globalThis.fetch = this.bunFetchWrapper;
			} else if (globalThis.fetch !== this.bunFetchWrapper) {
				throw new Error("Global fetch changed while the Bun HTTP dispatcher host was active");
			}
			this.bunSettings = { ...settings, timeoutMs };
			return;
		}
		const nextDispatcher = createHttpDispatcher(settings);
		const previousDispatcher = this.ownedDispatcher;
		undiciRuntime.setGlobalDispatcher(nextDispatcher);
		this.ownedDispatcher = nextDispatcher;
		if (previousDispatcher) await previousDispatcher.close();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (!undiciRuntime) {
			if (this.bunFetchWrapper && globalThis.fetch === this.bunFetchWrapper) globalThis.fetch = this.originalFetch!;
			if (this.installedNoProxy !== undefined && process.env.NO_PROXY === this.installedNoProxy) {
				delete process.env.NO_PROXY;
			}
			this.bunFetchWrapper = undefined;
			this.bunSettings = undefined;
			this.installedNoProxy = undefined;
			return;
		}
		const dispatcher = this.ownedDispatcher;
		if (!dispatcher) return;
		if (undiciRuntime.getGlobalDispatcher() === dispatcher)
			undiciRuntime.setGlobalDispatcher(this.originalDispatcher!);
		this.ownedDispatcher = undefined;
		await dispatcher.close();
	}
}
