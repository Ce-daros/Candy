import type { AuthType } from "@candy/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createAuthFlowHarness } from "./auth-flow-harness.ts";

describe("InteractiveAuthFlow login lifecycle", () => {
	beforeEach(() => initTheme("dark", false));

	it.each(["api_key", "oauth"] as const)("does not report an error when %s login is cancelled", async (type) => {
		let rejectLogin!: (error: Error) => void;
		const harness = createAuthFlowHarness(
			type,
			async () =>
				new Promise<void>((_resolve, reject) => {
					rejectLogin = reject;
				}),
		);
		const pending = harness.flow.handleLoginCommand("test-provider");
		await vi.waitFor(() => expect(harness.dialog).toBeDefined());
		harness.dialog?.abort();
		rejectLogin(new Error("Login cancelled"));
		await pending;

		expect(harness.errors).toEqual([]);
		expect(harness.models.refresh).not.toHaveBeenCalled();
		expect(harness.frames.all).toEqual([]);
		harness.flow.dispose();
	});

	it.each(["api_key", "oauth"] as const)("does not report a failure after leaving the %s login page", async (type) => {
		let rejectLogin!: (error: Error) => void;
		const harness = createAuthFlowHarness(
			type,
			async () =>
				new Promise<void>((_resolve, reject) => {
					rejectLogin = reject;
				}),
		);
		const pending = harness.flow.handleLoginCommand("test-provider");
		await vi.waitFor(() => expect(harness.dialog).toBeDefined());
		harness.pageController.dismissFrom(harness.pageController.currentFrame!);
		rejectLogin(new Error("Login was aborted"));
		await pending;

		expect(harness.errors).toEqual([]);
		expect(harness.models.refresh).not.toHaveBeenCalled();
		expect(harness.frames.all).toEqual([]);
		harness.flow.dispose();
	});

	it.each(["api_key", "oauth"] as const)("ignores a %s login rejection after session replacement", async (type) => {
		let rejectLogin!: (error: Error) => void;
		const harness = createAuthFlowHarness(
			type,
			async () =>
				new Promise<void>((_resolve, reject) => {
					rejectLogin = reject;
				}),
		);
		const pending = harness.flow.handleLoginCommand("test-provider");
		await vi.waitFor(() => expect(harness.dialog).toBeDefined());
		harness.replaceSession();
		rejectLogin(new Error("late provider failure"));
		await pending;

		expect(harness.errors).toEqual([]);
		expect(harness.models.refresh).not.toHaveBeenCalled();
		expect(harness.frames.all).toEqual([]);
		harness.flow.dispose();
	});

	it.each(["api_key", "oauth"] as const)("ignores a late %s success after session replacement", async (type) => {
		let resolveLogin!: () => void;
		const harness = createAuthFlowHarness(
			type,
			async () =>
				new Promise<void>((resolve) => {
					resolveLogin = resolve;
				}),
		);
		const pending = harness.flow.handleLoginCommand("test-provider");
		await vi.waitFor(() => expect(harness.dialog).toBeDefined());
		harness.replaceSession();
		resolveLogin();
		await pending;

		expect(harness.errors).toEqual([]);
		expect(harness.models.refresh).not.toHaveBeenCalled();
		expect(harness.frames.all).toEqual([]);
		harness.flow.dispose();
	});

	it.each(["api_key", "oauth"] as const)(
		"does not refresh after a cancelled %s login later succeeds",
		async (type) => {
			let resolveLogin!: () => void;
			const harness = createAuthFlowHarness(
				type,
				async () =>
					new Promise<void>((resolve) => {
						resolveLogin = resolve;
					}),
			);
			const pending = harness.flow.handleLoginCommand("test-provider");
			await vi.waitFor(() => expect(harness.dialog).toBeDefined());
			harness.flow.cancelActiveLogin();
			resolveLogin();
			await pending;

			expect(harness.errors).toEqual([]);
			expect(harness.models.refresh).not.toHaveBeenCalled();
			expect(harness.frames.all).toEqual([]);
			harness.flow.dispose();
		},
	);

	it.each(["api_key", "oauth"] as const)("keeps a real %s login failure visible", async (type: AuthType) => {
		const harness = createAuthFlowHarness(type, async () => {
			throw new Error("provider refused credentials");
		});
		await harness.flow.handleLoginCommand("test-provider");

		expect(harness.errors).toEqual([
			{
				message: "Test Provider: provider refused credentials",
				title: type === "api_key" ? "Could not save API key" : "Authentication failed",
			},
		]);
		expect(harness.models.refresh).not.toHaveBeenCalled();
		harness.flow.dispose();
	});

	it.each(["api_key", "oauth"] as const)(
		"does not remount a select prompt after %s login is aborted",
		async (type) => {
			const harness = createAuthFlowHarness(type, async ({ prompt }) => {
				await prompt({
					type: "select",
					message: "Choose account",
					options: [{ id: "one", label: "One" }],
				});
			});
			const pending = harness.flow.handleLoginCommand("test-provider");
			await vi.waitFor(() => expect(harness.mounted.at(-1)?.component).toBeInstanceOf(ExtensionSelectorComponent));
			const selector = harness.mounted.at(-1)?.component as ExtensionSelectorComponent;
			const mountedCount = harness.mounted.length;
			harness.flow.cancelActiveLogin();
			await pending;
			selector.handleInput("\r");

			expect(harness.mounted).toHaveLength(mountedCount);
			expect(harness.frames.all).toEqual([]);
			expect(harness.models.refresh).not.toHaveBeenCalled();
			harness.flow.dispose();
		},
	);
});
