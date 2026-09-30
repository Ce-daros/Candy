import type { ModelsRefreshOptions, ModelsRefreshResult } from "@candy/ai";
import { Text } from "@candy/tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createAuthFlowHarness } from "./auth-flow-harness.ts";

describe("InteractiveAuthFlow", () => {
	beforeEach(() => initTheme("dark", false));

	it("cancels a nested provider selection and restores the source page without duplicate frames", async () => {
		let loginSignal: AbortSignal | undefined;
		const harness = createAuthFlowHarness("api_key", async ({ signal, prompt }) => {
			loginSignal = signal;
			await prompt({
				type: "select",
				message: "Choose a region",
				options: [
					{ id: "west", label: "West" },
					{ id: "east", label: "East" },
				],
			});
		});
		const source = harness.pageController.mountPanel(new Text("Sources", 0, 0));
		const login = harness.flow.handleLoginCommand("test-provider");

		await vi.waitFor(() => expect(harness.frames.all).toHaveLength(3));
		expect(harness.mounted.at(-1)?.component).toBeInstanceOf(ExtensionSelectorComponent);
		(harness.mounted.at(-1)?.component as ExtensionSelectorComponent).handleInput("\x1b");
		await login;

		expect(loginSignal?.aborted).toBe(true);
		expect(harness.frames.all).toEqual([source]);
		expect(harness.models.refresh).not.toHaveBeenCalled();
		harness.flow.dispose();
	});

	it("uses the shared flow stack for nested auth selection, refresh, and flow invalidation", async () => {
		let resolveRefresh!: (result: { aborted: boolean; errors: Map<string, Error> }) => void;
		let refreshSignal: AbortSignal | undefined;
		const harness = createAuthFlowHarness("api_key", async ({ prompt }) => {
			await prompt({
				type: "select",
				message: "Choose a region",
				options: [{ id: "west", label: "West" }],
			});
		});
		harness.models.refresh.mockImplementation(async ({ signal }) => {
			refreshSignal = signal;
			return new Promise((resolve) => {
				resolveRefresh = resolve;
			});
		});
		const source = harness.pageController.mountPanel(new Text("Sources", 0, 0));
		const login = harness.flow.handleLoginCommand("test-provider");
		await vi.waitFor(() => expect(harness.frames.all).toHaveLength(3));
		const selector = harness.mounted.at(-1)?.component as ExtensionSelectorComponent;
		selector.handleInput("\r");
		await vi.waitFor(() => expect(harness.models.refresh).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(harness.frames.all).toEqual([source]));
		expect(harness.mounted.at(-1)?.component).toBeInstanceOf(Text);
		const otherPage = harness.pageController.mountPanel(new Text("Settings", 0, 0));
		expect(refreshSignal?.aborted).toBe(true);
		resolveRefresh({ aborted: true, errors: new Map() });
		await login;

		expect(harness.warnings).toEqual([]);
		expect(harness.frames.all).toEqual([source, otherPage]);
		harness.flow.dispose();
	});

	it("aborts active authentication when the session changes", async () => {
		let signal: AbortSignal | undefined;
		const harness = createAuthFlowHarness("api_key", async ({ signal: currentSignal }) => {
			signal = currentSignal;
			await new Promise<void>((_resolve, reject) => {
				currentSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		});
		const source = harness.pageController.mountPanel(new Text("Sources", 0, 0));
		const login = harness.flow.handleLoginCommand("test-provider");
		await vi.waitFor(() => expect(harness.frames.all).toHaveLength(2));
		harness.replaceSession();
		await login;

		expect(signal?.aborted).toBe(true);
		expect(harness.frames.all).toEqual([source]);
		harness.flow.dispose();
	});

	it("refreshes the model catalog after successful authentication", async () => {
		const harness = createAuthFlowHarness("api_key", async () => {});
		await harness.flow.handleLoginCommand("test-provider");
		expect(harness.models.refresh).toHaveBeenCalledOnce();
		harness.flow.dispose();
	});

	it("keeps the model runtime captured when a login starts", async () => {
		let finishLogin!: () => void;
		const harness = createAuthFlowHarness(
			"api_key",
			async () =>
				new Promise<void>((resolve) => {
					finishLogin = resolve;
				}),
		);
		const login = harness.flow.handleLoginCommand("test-provider");
		await vi.waitFor(() => expect(harness.models.login).toHaveBeenCalledOnce());
		const nextModels = {
			...harness.models,
			refresh: vi.fn(
				async (_options: ModelsRefreshOptions): Promise<ModelsRefreshResult> => ({
					aborted: false,
					errors: new Map(),
				}),
			),
		};
		harness.replaceModels(nextModels);
		finishLogin();
		await login;

		expect(harness.models.refresh).toHaveBeenCalledOnce();
		expect(nextModels.refresh).not.toHaveBeenCalled();
		harness.flow.dispose();
	});

	it("aborts catalog refresh when the session changes", async () => {
		let resolveRefresh!: (result: ModelsRefreshResult) => void;
		let refreshSignal: AbortSignal | undefined;
		const harness = createAuthFlowHarness("api_key", async () => {});
		harness.models.refresh.mockImplementation(async ({ signal }) => {
			refreshSignal = signal;
			return new Promise((resolve) => {
				resolveRefresh = resolve;
			});
		});
		const login = harness.flow.handleLoginCommand("test-provider");
		await vi.waitFor(() => expect(harness.models.refresh).toHaveBeenCalledOnce());
		harness.replaceSession();
		expect(refreshSignal?.aborted).toBe(true);
		resolveRefresh({ aborted: true, errors: new Map() });
		await login;

		expect(harness.warnings).toEqual([]);
		harness.flow.dispose();
	});

	it("reports authentication errors and closes the dialog without refreshing models", async () => {
		const harness = createAuthFlowHarness("api_key", async () => {
			throw new Error("invalid credentials");
		});
		await harness.flow.handleLoginCommand("test-provider");

		expect(harness.errors).toEqual([
			{ message: "Test Provider: invalid credentials", title: "Could not save API key" },
		]);
		expect(harness.models.refresh).not.toHaveBeenCalled();
		expect(harness.frames.all).toEqual([]);
		harness.flow.dispose();
	});
});
