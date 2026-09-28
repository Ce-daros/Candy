import type { AuthPrompt } from "@candy/ai";
import type { TUI } from "@candy/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

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
});
