import { setKeybindings } from "@candy/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandPanel } from "../src/modes/interactive/components/command-panel.ts";
import { InteractivePresentation, type PresentationHost } from "../src/modes/interactive/interactive-presentation.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { KeybindingsManager } from "../src/presentation/keybindings.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("Sources catalog lifecycle", () => {
	let harness: Harness | undefined;

	beforeEach(async () => {
		initTheme("dark");
		setKeybindings(KeybindingsManager.create());
	});

	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	// Regression for #6999: refreshing Sources must publish the changed provider catalog.
	it("shows a provider catalog refresh error and keeps the provider page active", async () => {
		harness = await createHarness();
		const runtime = harness.session.modelRuntime;
		const provider = runtime.getProviders()[0]!;
		const refresh = vi.spyOn(runtime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([[provider.id, new Error("unavailable")]]),
		});
		let panel!: CommandPanel;
		const host: PresentationHost = {
			session: () => harness!.session,
			settings: () => harness!.settingsManager,
			mount(next) {
				panel = next;
			},
			exit() {},
			render() {},
			read() {},
			reportError() {},
			applyQuickSelection: async () => {},
			edit: async () => undefined,
			login: async () => {},
			skills: async () => {},
			settingsActions: () => [],
			localCommands: () => [],
			historyCommands: () => [],
			historyAction: async () => {},
		};
		const presentation = new InteractivePresentation(host);
		presentation.open("sources");
		panel.handleInput(provider.name);
		panel.handleInput("\r");
		await vi.waitFor(() => expect(panel.render(80).join("\n")).toContain("Refresh catalog"));
		panel.handleInput("refresh");
		panel.handleInput("\r");

		await vi.waitFor(() => expect(panel.render(80).join("\n")).toContain("Refresh failed: unavailable"));
		expect(refresh).toHaveBeenCalledWith({ providers: [provider.id], signal: expect.any(AbortSignal) });
		expect(presentation.surface).toBe("sources");
		presentation.dispose();
	});

	it("does not restore a provider page after its refresh completes late", async () => {
		harness = await createHarness();
		const runtime = harness.session.modelRuntime;
		const provider = runtime.getProviders()[0]!;
		let finishRefresh!: (value: { aborted: boolean; errors: Map<string, Error> }) => void;
		const refreshDone = new Promise<{ aborted: boolean; errors: Map<string, Error> }>((resolve) => {
			finishRefresh = resolve;
		});
		const refresh = vi.spyOn(runtime, "refresh").mockReturnValue(refreshDone);
		const mount = vi.fn((next: CommandPanel) => {
			panel = next;
		});
		let panel!: CommandPanel;
		const host: PresentationHost = {
			session: () => harness!.session,
			settings: () => harness!.settingsManager,
			mount,
			exit() {},
			render() {},
			read() {},
			reportError() {},
			applyQuickSelection: async () => {},
			edit: async () => undefined,
			login: async () => {},
			skills: async () => {},
			settingsActions: () => [],
			localCommands: () => [],
			historyCommands: () => [],
			historyAction: async () => {},
		};
		const presentation = new InteractivePresentation(host);
		presentation.open("sources");
		const rootPanel = panel;
		panel.handleInput(provider.name);
		panel.handleInput("\r");
		await vi.waitFor(() => expect(panel.render(80).join("\n")).toContain("Refresh catalog"));
		const providerPanel = panel;
		providerPanel.handleInput("refresh");
		providerPanel.handleInput("\r");
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
		const signal = refresh.mock.calls[0]![0]!.signal!;

		providerPanel.handleInput("\u001b");
		expect(signal.aborted).toBe(true);
		expect(panel).toBe(rootPanel);
		const mountsAfterBack = mount.mock.calls.length;
		finishRefresh({ aborted: false, errors: new Map() });
		await refreshDone;

		expect(panel).toBe(rootPanel);
		expect(mount).toHaveBeenCalledTimes(mountsAfterBack);
		presentation.dispose();
	});
});
