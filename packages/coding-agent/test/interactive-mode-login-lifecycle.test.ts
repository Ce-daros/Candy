import type { AuthPrompt } from "@candy/ai";
import type { TUI } from "@candy/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createLoginHarness(method: "api_key" | "oauth") {
	let resolveLogin: () => void = () => {};
	let rejectLogin: (error: Error) => void = () => {};
	let currentSession = { model: undefined };
	const context: any = {
		get session() {
			return currentSession;
		},
		ui: { requestRender: vi.fn() } as unknown as TUI,
		activeLogin: undefined as { dialog: LoginDialogComponent; session: typeof currentSession } | undefined,
		mountPanel: vi.fn(),
		closePanel: vi.fn(),
		showError: vi.fn(),
		loginProvider: vi.fn(
			() =>
				new Promise<void>((resolve, reject) => {
					resolveLogin = resolve;
					rejectLogin = reject;
				}),
		),
		completeProviderAuthentication: vi.fn(),
		finishLoginDialog(dialog: LoginDialogComponent) {
			return (
				Reflect.get(InteractiveMode.prototype, "finishLoginDialog") as (dialog: LoginDialogComponent) => boolean
			).call(context, dialog);
		},
		cancelActiveLogin() {
			(Reflect.get(InteractiveMode.prototype, "cancelActiveLogin") as () => void).call(context);
		},
	};
	const handlerName = method === "api_key" ? "showApiKeyLoginDialog" : "showLoginDialog";
	const start = Reflect.get(InteractiveMode.prototype, handlerName) as (
		this: typeof context,
		providerId: string,
		providerName: string,
	) => Promise<void>;
	const pending = start.call(context, "example", "Example");
	const activeDialog = context.activeLogin?.dialog as LoginDialogComponent | undefined;
	return {
		context,
		pending,
		dialog: () => activeDialog,
		rejectLogin: (error = new Error("Login cancelled")) => rejectLogin(error),
		resolveLogin,
		replaceSession: () => {
			currentSession = { model: undefined };
		},
	};
}

describe("InteractiveMode login lifecycle", () => {
	beforeAll(() => initTheme("dark"));

	it("ignores a login result after the session changes", async () => {
		let resolveLogin: () => void = () => {};
		let currentSession = { model: undefined };
		const context = {
			get session() {
				return currentSession;
			},
			ui: { requestRender: vi.fn() } as unknown as TUI,
			activeLogin: undefined as { dialog: LoginDialogComponent; session: typeof currentSession } | undefined,
			mountPanel: vi.fn(),
			closePanel: vi.fn(),
			loginProvider: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						resolveLogin = resolve;
					}),
			),
			completeProviderAuthentication: vi.fn(),
			finishLoginDialog(dialog: LoginDialogComponent) {
				return (
					Reflect.get(InteractiveMode.prototype, "finishLoginDialog") as (dialog: LoginDialogComponent) => boolean
				).call(context, dialog);
			},
			cancelActiveLogin() {
				(Reflect.get(InteractiveMode.prototype, "cancelActiveLogin") as () => void).call(context);
			},
		};
		const showLoginDialog = Reflect.get(InteractiveMode.prototype, "showLoginDialog") as (
			this: typeof context,
			providerId: string,
			providerName: string,
		) => Promise<void>;

		const pending = showLoginDialog.call(context, "example", "Example");
		const dialog = context.activeLogin?.dialog;
		expect(dialog).toBeInstanceOf(LoginDialogComponent);
		context.cancelActiveLogin();
		currentSession = { model: undefined };
		resolveLogin();
		await pending;

		expect(dialog?.signal.aborted).toBe(true);
		expect(context.closePanel).not.toHaveBeenCalled();
		expect(context.completeProviderAuthentication).not.toHaveBeenCalled();
	});

	it("does not remount a select prompt after login is aborted", async () => {
		const session = { model: undefined };
		const dialog = new LoginDialogComponent({ requestRender: vi.fn() } as unknown as TUI, "example", vi.fn());
		let selector: ExtensionSelectorComponent | undefined;
		const context = {
			session,
			activeLogin: { dialog, session } as { dialog: LoginDialogComponent; session: typeof session } | undefined,
			panelGeneration: 0,
			mountPanel: vi.fn((panel: ExtensionSelectorComponent | LoginDialogComponent) => {
				context.panelGeneration++;
				if (panel instanceof ExtensionSelectorComponent) selector = panel;
			}),
			isActiveLogin(candidate: LoginDialogComponent) {
				return (
					Reflect.get(InteractiveMode.prototype, "isActiveLogin") as (dialog: LoginDialogComponent) => boolean
				).call(context, candidate);
			},
			cancelActiveLogin() {
				(Reflect.get(InteractiveMode.prototype, "cancelActiveLogin") as () => void).call(context);
			},
		};
		const showAuthSelect = Reflect.get(InteractiveMode.prototype, "showAuthSelect") as (
			this: typeof context,
			dialog: LoginDialogComponent,
			prompt: Extract<AuthPrompt, { type: "select" }>,
		) => Promise<string>;
		const pending = showAuthSelect.call(context, dialog, {
			type: "select",
			message: "Choose account",
			options: [{ id: "one", label: "One" }],
		});

		context.cancelActiveLogin();
		await expect(pending).rejects.toThrow("Login cancelled");
		selector?.handleInput("\r");
		expect(context.mountPanel).toHaveBeenCalledTimes(1);
	});

	it.each(["api_key", "oauth"] as const)(
		"does not report save failure when the user cancels %s login",
		async (method) => {
			const harness = createLoginHarness(method);
			harness.dialog()?.abort();
			harness.rejectLogin();
			await harness.pending;

			expect(harness.context.showError).not.toHaveBeenCalled();
			expect(harness.context.completeProviderAuthentication).not.toHaveBeenCalled();
		},
	);

	it.each(["api_key", "oauth"] as const)("does not report failure after leaving the %s login page", async (method) => {
		const harness = createLoginHarness(method);
		harness.context.cancelActiveLogin();
		harness.rejectLogin(new Error("Login was aborted"));
		await harness.pending;

		expect(harness.dialog()?.signal.aborted).toBe(true);
		expect(harness.context.showError).not.toHaveBeenCalled();
		expect(harness.context.completeProviderAuthentication).not.toHaveBeenCalled();
	});

	it.each(["api_key", "oauth"] as const)("ignores a %s login rejection after session replacement", async (method) => {
		const harness = createLoginHarness(method);
		harness.replaceSession();
		harness.rejectLogin(new Error("late provider failure"));
		await harness.pending;

		expect(harness.context.showError).not.toHaveBeenCalled();
		expect(harness.context.completeProviderAuthentication).not.toHaveBeenCalled();
	});

	it.each(["api_key", "oauth"] as const)(
		"does not apply a late %s login success to a replacement session",
		async (method) => {
			const harness = createLoginHarness(method);
			harness.replaceSession();
			harness.resolveLogin();
			await harness.pending;

			expect(harness.context.closePanel).not.toHaveBeenCalled();
			expect(harness.context.completeProviderAuthentication).not.toHaveBeenCalled();
			expect(harness.context.showError).not.toHaveBeenCalled();
		},
	);

	it.each(["api_key", "oauth"] as const)(
		"does not apply a %s login success that arrives after cancellation",
		async (method) => {
			const harness = createLoginHarness(method);
			harness.dialog()?.abort();
			harness.resolveLogin();
			await harness.pending;

			expect(harness.context.completeProviderAuthentication).not.toHaveBeenCalled();
		},
	);

	it.each(["api_key", "oauth"] as const)("keeps a real %s login failure visible", async (method) => {
		const harness = createLoginHarness(method);
		harness.rejectLogin(new Error("provider refused credentials"));
		await harness.pending;

		expect(harness.context.showError).toHaveBeenCalledWith(
			"Example: provider refused credentials",
			method === "api_key" ? "Could not save API key" : "Authentication failed",
		);
	});
});
