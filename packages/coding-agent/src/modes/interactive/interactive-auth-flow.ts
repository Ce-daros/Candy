import type { AuthEvent, AuthPrompt, AuthType } from "@candy/ai";
import type { TUI } from "@candy/tui";
import { APP_NAME, getAuthPath } from "../../config.ts";
import { CredentialSynchronizationError, type ModelRuntime } from "../../core/model-runtime.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { LoginDialogComponent } from "./components/login-dialog.ts";
import {
	type AuthSelectorProvider,
	getAuthSelectorProviders,
	OAuthSelectorComponent,
} from "./components/oauth-selector.ts";
import type { InteractivePageController } from "./interactive-page-controller.ts";

type AuthModels = Pick<ModelRuntime, "getProviders" | "getProviderAuthStatus" | "isUsingOAuth" | "login" | "refresh">;

export interface InteractiveAuthFlowHost {
	models: AuthModels;
	pageController: InteractivePageController;
	renderer: TUI;
	getSessionIdentity(): object;
	getFlowGeneration(): number;
	subscribeSessionChanges(listener: () => void): () => void;
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string, title?: string): void;
	refreshAuthenticationPresentation(): Promise<void>;
	warnAboutAnthropicSubscription(): void;
	requestRender(): void;
}

interface ActiveLogin {
	dialog: LoginDialogComponent;
	frame: ReturnType<InteractivePageController["mountPanel"]>;
	session: object;
	models: AuthModels;
}

const loginCancelled = () => new Error("Login cancelled");

export class InteractiveAuthFlow {
	private readonly host: InteractiveAuthFlowHost;
	private activeLogin: ActiveLogin | undefined;
	private refreshController: AbortController | undefined;
	private readonly unsubscribeFlows: () => void;
	private readonly unsubscribeSession: () => void;
	private disposed = false;

	constructor(host: InteractiveAuthFlowHost) {
		this.host = host;
		this.unsubscribeFlows = host.pageController.subscribeFlows(() => {
			const login = this.activeLogin;
			if (login && (!host.pageController.contains(login.frame) || host.getSessionIdentity() !== login.session)) {
				this.cancelActiveLogin();
			}
		});
		this.unsubscribeSession = host.subscribeSessionChanges(() => {
			this.cancelActiveLogin();
			this.refreshController?.abort();
		});
	}

	async handleLoginCommand(providerRef?: string): Promise<void> {
		if (this.disposed) throw new Error("Authentication flow is disposed");
		const models = this.host.models;
		if (!providerRef) {
			this.showLoginAuthTypeSelector(models);
			return;
		}

		const providerOptions = this.findLoginProviderOptions(models, providerRef);
		if (providerOptions.length === 1) {
			await this.startProviderLogin(models, providerOptions[0]!);
			return;
		}
		if (providerOptions.length > 1 && new Set(providerOptions.map((provider) => provider.id)).size === 1) {
			this.showLoginAuthTypeSelector(models, providerOptions);
			return;
		}
		this.showLoginProviderSelector(models, undefined, providerRef);
	}

	cancelActiveLogin(): void {
		const login = this.activeLogin;
		this.activeLogin = undefined;
		if (!login) return;
		login.dialog.abort();
		this.host.pageController.dismissFrom(login.frame);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelActiveLogin();
		this.refreshController?.abort();
		this.unsubscribeFlows();
		this.unsubscribeSession();
	}

	private getLoginProviderOptions(models: AuthModels, authType?: AuthType): AuthSelectorProvider[] {
		return getAuthSelectorProviders(models, authType);
	}

	private findLoginProviderOptions(models: AuthModels, providerRef: string): AuthSelectorProvider[] {
		const normalized = providerRef.trim().toLowerCase();
		if (!normalized) return [];
		return this.getLoginProviderOptions(models).filter(
			(provider) => provider.id.toLowerCase() === normalized || provider.name.toLowerCase() === normalized,
		);
	}

	private isCurrentSelector(session: object, frame: ReturnType<InteractivePageController["showSelector"]>): boolean {
		return this.host.getSessionIdentity() === session && this.host.pageController.currentFrame === frame;
	}

	private async startProviderLogin(models: AuthModels, provider: AuthSelectorProvider): Promise<void> {
		if (provider.authType === "api_key" && !provider.method?.login) {
			this.showAmbientAuthDialog(provider);
			return;
		}
		await this.showLoginDialog(models, provider.id, provider.name, provider.authType);
	}

	private showLoginAuthTypeSelector(models: AuthModels, providerOptions?: AuthSelectorProvider[]): void {
		const oauthProvider = providerOptions?.find((provider) => provider.authType === "oauth");
		const oauthLoginLabel =
			oauthProvider?.method && "loginLabel" in oauthProvider.method ? oauthProvider.method.loginLabel : undefined;
		const subscriptionLabel = oauthLoginLabel ?? "Sign in with an account";
		const apiKeyLabel = "Sign in with an API key";
		const authTypes = providerOptions
			? new Set(providerOptions.map((provider) => provider.authType))
			: new Set<AuthSelectorProvider["authType"]>(["oauth", "api_key"]);
		const options = [
			...(authTypes.has("oauth") ? [subscriptionLabel] : []),
			...(authTypes.has("api_key") ? [apiKeyLabel] : []),
		];
		if (options.length === 0) {
			this.host.showStatus("No login methods available.");
			return;
		}
		if (providerOptions && options.length === 1) {
			void this.startProviderLogin(models, providerOptions[0]!);
			return;
		}

		const title = providerOptions?.[0]
			? `Select authentication method for ${providerOptions[0].name}:`
			: "Select authentication method:";
		const session = this.host.getSessionIdentity();
		let frame: ReturnType<InteractivePageController["showSelector"]>;
		frame = this.host.pageController.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					if (!this.isCurrentSelector(session, frame)) return;
					done();
					const authType = option === subscriptionLabel ? "oauth" : "api_key";
					if (providerOptions) {
						const provider = providerOptions.find((entry) => entry.authType === authType);
						if (provider) void this.startProviderLogin(models, provider);
						return;
					}
					this.showLoginProviderSelector(models, authType);
				},
				() => {
					if (!this.isCurrentSelector(session, frame)) return;
					done();
					this.host.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showLoginProviderSelector(
		models: AuthModels,
		authType?: AuthSelectorProvider["authType"],
		initialSearchInput?: string,
	): void {
		const providerOptions = this.getLoginProviderOptions(models, authType);
		if (providerOptions.length === 0) {
			this.host.showStatus(
				authType === "oauth"
					? "No subscription providers available."
					: authType === "api_key"
						? "No API key providers available."
						: "No login providers available.",
			);
			return;
		}

		const session = this.host.getSessionIdentity();
		let frame: ReturnType<InteractivePageController["showSelector"]>;
		frame = this.host.pageController.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				"login",
				providerOptions,
				async (providerId, selectedAuthType) => {
					if (!this.isCurrentSelector(session, frame)) return;
					done();
					const provider = providerOptions.find(
						(entry) => entry.id === providerId && entry.authType === selectedAuthType,
					);
					if (provider) await this.startProviderLogin(models, provider);
				},
				() => {
					if (!this.isCurrentSelector(session, frame)) return;
					done();
					if (authType) this.showLoginAuthTypeSelector(models);
					else this.host.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	private showAmbientAuthDialog(provider: AuthSelectorProvider): void {
		const session = this.host.getSessionIdentity();
		let frame: ReturnType<InteractivePageController["mountPanel"]>;
		const dialog = new LoginDialogComponent(
			this.host.renderer,
			provider.id,
			() => {
				if (this.host.getSessionIdentity() === session) this.host.pageController.closePanel(frame);
			},
			provider.name,
			`${provider.name} setup`,
		);
		dialog.showInfo(`${provider.method?.name ?? "Authentication"} is configured outside ${APP_NAME}.`, [], true);
		frame = this.host.pageController.mountPanel(dialog, 0.5, dialog, "auth-ambient");
	}

	private async showLoginDialog(
		models: AuthModels,
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
	): Promise<void> {
		const session = this.host.getSessionIdentity();
		const dialog = new LoginDialogComponent(this.host.renderer, providerId, () => {}, providerName);
		const frame = this.host.pageController.mountPanel(dialog, 0.5, dialog, "auth");
		const login: ActiveLogin = { dialog, frame, session, models };
		this.activeLogin = login;

		try {
			await models.login(providerId, authType, {
				signal: dialog.signal,
				prompt: (prompt) => this.showAuthPrompt(login, prompt, authType === "api_key"),
				notify: (event) => this.notifyAuthDialog(login, event),
			});
		} catch (error: unknown) {
			if (!this.finishLogin(login)) return;
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof CredentialSynchronizationError) {
				this.host.showError(
					authType === "oauth"
						? `Logged in to ${providerName}, but local model state could not be synchronized: ${message}`
						: `Saved API key for ${providerName}, but local model state could not be synchronized: ${message}`,
				);
			} else if (!dialog.signal.aborted) {
				this.host.showError(
					`${providerName}: ${message}`,
					authType === "oauth" ? "Authentication failed" : "Could not save API key",
				);
			}
			return;
		}

		if (!this.finishLogin(login)) return;
		await this.completeProviderAuthentication(login.models, providerId, providerName, authType);
	}

	private finishLogin(login: ActiveLogin): boolean {
		if (this.activeLogin !== login || this.host.getSessionIdentity() !== login.session) return false;
		this.activeLogin = undefined;
		this.host.pageController.dismissFrom(login.frame);
		return !login.dialog.signal.aborted;
	}

	private showAuthPrompt(login: ActiveLogin, prompt: AuthPrompt, secret: boolean): Promise<string> {
		if (!this.isActiveLogin(login) || prompt.signal?.aborted) return Promise.reject(loginCancelled());
		const response =
			prompt.type === "select"
				? this.showAuthSelect(login, prompt)
				: prompt.type === "manual_code"
					? login.dialog.showManualInput(prompt.message)
					: login.dialog.showPrompt(prompt.message, prompt.placeholder, secret);
		const signals = prompt.signal ? [login.dialog.signal, prompt.signal] : [login.dialog.signal];
		if (signals.some((signal) => signal.aborted)) return Promise.reject(loginCancelled());
		let rejectAbort!: (error: Error) => void;
		const aborted = new Promise<string>((_resolve, reject) => {
			rejectAbort = reject;
			for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
		});
		function onAbort(): void {
			rejectAbort(loginCancelled());
		}
		return Promise.race([response, aborted]).finally(() => {
			for (const signal of signals) signal.removeEventListener("abort", onAbort);
		});
	}

	private showAuthSelect(login: ActiveLogin, prompt: Extract<AuthPrompt, { type: "select" }>): Promise<string> {
		return new Promise((resolve, reject) => {
			let settled = false;
			let removeAbort = (): void => {};
			const finish = (value?: string) => {
				if (settled) return;
				settled = true;
				removeAbort();
				if (value) {
					resolve(value);
					return;
				}
				login.dialog.abort();
				reject(loginCancelled());
			};
			const frame = this.host.pageController.showSelector((done) => {
				const selector = new ExtensionSelectorComponent(
					prompt.message,
					prompt.options.map((option) => option.label),
					(label) => {
						if (this.isActiveLogin(login)) {
							finish(prompt.options.find((option) => option.label === label)?.id);
							done();
						}
					},
					() => {
						if (this.isActiveLogin(login)) {
							finish();
							done();
						}
					},
				);
				return { component: selector, focus: selector };
			});
			const signal = frame.controller.signal;
			const onAbort = () => {
				if (!settled) {
					settled = true;
					removeAbort();
					reject(loginCancelled());
				}
			};
			signal.addEventListener("abort", onAbort, { once: true });
			removeAbort = () => signal.removeEventListener("abort", onAbort);
			if (signal.aborted) onAbort();
		});
	}

	private notifyAuthDialog(login: ActiveLogin, event: AuthEvent): void {
		if (!this.isActiveLogin(login)) return;
		if (event.type === "auth_url") login.dialog.showAuth(event.url, event.instructions);
		else if (event.type === "device_code") {
			login.dialog.showDeviceCode(event);
			login.dialog.showWaiting("Waiting for authentication...");
		} else if (event.type === "info") login.dialog.showInfo(event.message, event.links);
		else login.dialog.showProgress(event.message);
	}

	private isActiveLogin(login: ActiveLogin): boolean {
		return (
			this.activeLogin === login &&
			this.host.getSessionIdentity() === login.session &&
			this.host.pageController.isWithin(login.frame) &&
			!login.dialog.signal.aborted
		);
	}

	private async completeProviderAuthentication(
		models: AuthModels,
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
	): Promise<void> {
		const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;
		const session = this.host.getSessionIdentity();
		const generation = this.host.getFlowGeneration();
		this.host.showStatus(`${actionLabel}. Refreshing model catalog…`);

		const controller = new AbortController();
		this.refreshController?.abort();
		this.refreshController = controller;
		const unsubscribe = this.host.pageController.subscribeFlows((nextGeneration) => {
			if (nextGeneration !== generation) controller.abort();
		});
		const timeout = setTimeout(() => controller.abort(), 15_000);
		const isCurrent = () =>
			this.host.getSessionIdentity() === session && this.host.getFlowGeneration() === generation;
		try {
			const result = await models.refresh({ providers: [providerId], signal: controller.signal });
			if (!isCurrent()) return;
			await this.host.refreshAuthenticationPresentation();
			if (!isCurrent()) return;
			const error = result.errors.get(providerId);
			if (result.aborted) this.host.showWarning(`${actionLabel}, but the model catalog refresh timed out.`);
			else if (error)
				this.host.showWarning(`${actionLabel}, but the model catalog refresh failed: ${error.message}`);
			else this.host.showStatus(`${actionLabel}. Credentials saved to ${getAuthPath()}`);
			this.host.warnAboutAnthropicSubscription();
			this.host.requestRender();
		} catch (error: unknown) {
			if (!isCurrent()) return;
			this.host.showWarning(
				`${actionLabel}, but its model catalog could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			clearTimeout(timeout);
			unsubscribe();
			if (this.refreshController === controller) this.refreshController = undefined;
		}
	}
}
