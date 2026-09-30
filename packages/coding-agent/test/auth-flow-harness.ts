import type {
	AuthInteraction,
	AuthPrompt,
	AuthType,
	ModelsRefreshOptions,
	ModelsRefreshResult,
	Provider,
	ProviderAuthInteraction,
} from "@candy/ai";
import { fauxProvider } from "@candy/ai";
import type { TUI } from "@candy/tui";
import { vi } from "vitest";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import type { InteractiveAuthFlowHost } from "../src/modes/interactive/interactive-auth-flow.ts";
import { InteractiveAuthFlow } from "../src/modes/interactive/interactive-auth-flow.ts";
import { InteractiveFlowStack } from "../src/modes/interactive/interactive-flow-stack.ts";
import { InteractivePageController } from "../src/modes/interactive/interactive-page-controller.ts";

export interface AuthFlowLoginInput {
	type: AuthType;
	signal: AbortSignal;
	prompt: (prompt: AuthPrompt) => Promise<string>;
}

export function createAuthFlowHarness(authType: AuthType, login: (input: AuthFlowLoginInput) => Promise<void>) {
	const frames = new InteractiveFlowStack();
	const mounted: Array<{ component: unknown; input: unknown }> = [];
	const pageController = new InteractivePageController(
		{
			closeTranscriptSearch: () => {},
			mount: (component, _heightRatio, input) => mounted.push({ component, input }),
			focusEditor: () => {},
			closeAnimation: () => {},
			restoreEditor: () => {},
			requestRender: () => {},
		},
		frames,
	);
	let session: object = {};
	const sessionListeners = new Set<() => void>();
	const status: string[] = [];
	const warnings: string[] = [];
	const errors: Array<{ message: string; title?: string }> = [];
	const refresh = vi.fn(
		async (_options: ModelsRefreshOptions): Promise<ModelsRefreshResult> => ({
			aborted: false,
			errors: new Map<string, Error>(),
		}),
	);
	const provider: Provider = {
		...fauxProvider().provider,
		id: "test-provider",
		name: "Test Provider",
		auth:
			authType === "api_key"
				? {
						apiKey: {
							name: "API key",
							login: async (interaction: ProviderAuthInteraction) => {
								await login({ type: "api_key", ...interaction });
								return { type: "api_key" as const, key: "test" };
							},
							resolve: async () => undefined,
						},
					}
				: {
						oauth: {
							name: "Test OAuth",
							login: async (interaction: ProviderAuthInteraction) => {
								await login({ type: "oauth", ...interaction });
								return {
									type: "oauth" as const,
									refresh: "refresh-token",
									access: "access-token",
									expires: Date.now() + 60_000,
								};
							},
							refresh: async (credential, _signal) => credential,
							toAuth: async () => ({ apiKey: "test" }),
						},
					},
	};
	const models = {
		getProviders: () => [provider],
		getProviderAuthStatus: () => ({ configured: false }),
		isUsingOAuth: () => false,
		login: vi.fn(async (_providerId: string, _type: AuthType, options: AuthInteraction) => {
			if (!options.signal) throw new Error("Authentication test requires a cancellation signal");
			await login({ type: _type, signal: options.signal, prompt: options.prompt });
			return { type: "api_key" as const, key: "test" };
		}),
		refresh,
	};
	const host: InteractiveAuthFlowHost = {
		models: models as unknown as InteractiveAuthFlowHost["models"],
		pageController,
		renderer: { requestRender: () => {} } as unknown as TUI,
		getSessionIdentity: () => session,
		getFlowGeneration: () => pageController.generation,
		subscribeSessionChanges: (listener) => {
			sessionListeners.add(listener);
			return () => sessionListeners.delete(listener);
		},
		showStatus: (message) => status.push(message),
		showWarning: (message) => warnings.push(message),
		showError: (message, title) => errors.push({ message, title }),
		refreshAuthenticationPresentation: async () => {},
		warnAboutAnthropicSubscription: () => {},
		requestRender: () => {},
	};
	const flow = new InteractiveAuthFlow(host);
	return {
		flow,
		frames,
		pageController,
		mounted,
		models,
		replaceModels: (next: InteractiveAuthFlowHost["models"]) => {
			host.models = next;
		},
		status,
		warnings,
		errors,
		sessionListeners,
		get currentSession() {
			return session;
		},
		replaceSession() {
			session = {};
			for (const listener of sessionListeners) listener();
		},
		get dialog(): LoginDialogComponent | undefined {
			const content = pageController.currentFrame?.content;
			return content instanceof LoginDialogComponent ? content : undefined;
		},
	};
}
