import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIDialogOptions } from "../src/core/extensions/types.ts";
import type { ResolvedPaths } from "../src/core/package-manager.ts";
import { ResourceConfiguration } from "../src/core/resource-configuration.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.ts";
import type { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import type { ExtensionInputComponent } from "../src/modes/interactive/components/extension-input.ts";
import type { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { ReadingPanelComponent } from "../src/modes/interactive/components/reading-panel.ts";
import { InteractiveFlowStack } from "../src/modes/interactive/interactive-flow-stack.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { InteractivePageController } from "../src/modes/interactive/interactive-page-controller.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { KeybindingsManager } from "../src/presentation/keybindings.ts";

type DialogMode = {
	showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined>;
	showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined>;
	showExtensionEditor(title: string, prefill?: string): Promise<string | undefined>;
	showSkillConfiguration(): Promise<void>;
};

function createHarness() {
	const flows = new InteractiveFlowStack();
	const restoreEditor = vi.fn();
	const pageController = new InteractivePageController(
		{
			closeTranscriptSearch: () => {},
			mount: () => {},
			focusEditor: () => {},
			closeAnimation: (done) => done(),
			restoreEditor,
			requestRender: () => {},
		},
		flows,
	);
	const settings = SettingsManager.inMemory();
	const reload = vi.fn(async () => {});
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		pageController,
		renderer: { requestRender: () => {}, terminal: { rows: 24 } },
		keybindings: KeybindingsManager.create(),
		runtimeHost: { settings },
		handleReloadCommand: reload,
		presentation: { resume: vi.fn() },
	});
	return { mode: mode as unknown as DialogMode, flows, pageController, restoreEditor, settings, reload };
}

describe("InteractiveMode panel lifetimes", () => {
	beforeEach(() => initTheme("dark", false));

	it("settles a replaced dialog and ignores its later abort and selection", async () => {
		const { mode, flows } = createHarness();
		const firstAbort = new AbortController();
		const first = mode.showExtensionSelector("First", ["one"], { signal: firstAbort.signal });
		const firstComponent = flows.current!.content as ExtensionSelectorComponent;
		const second = mode.showExtensionSelector("Second", ["two"]);
		const secondFrame = flows.current;
		expect(await first).toBeUndefined();
		firstAbort.abort();
		firstComponent.handleInput("\r");
		expect(flows.current).toBe(secondFrame);
		(flows.current!.content as ExtensionSelectorComponent).handleInput("\r");
		expect(await second).toBe("two");
		expect(flows.all).toHaveLength(0);
	});

	it.each(["selector", "input", "editor"] as const)("settles and disposes a %s on flow invalidation", async (kind) => {
		vi.useFakeTimers();
		try {
			const { mode, flows, pageController } = createHarness();
			const pending =
				kind === "selector"
					? mode.showExtensionSelector("Choose", ["one"], { timeout: 30_000 })
					: kind === "input"
						? mode.showExtensionInput("Enter", undefined, { timeout: 30_000 })
						: mode.showExtensionEditor("Edit", "draft");
			pageController.invalidateFlows();
			expect(await pending).toBeUndefined();
			expect(flows.all).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("completes input and editor dialogs through their owning frames", async () => {
		const { mode, flows, restoreEditor } = createHarness();
		const input = mode.showExtensionInput("Enter");
		const inputComponent = flows.current!.content as ExtensionInputComponent;
		inputComponent.handleInput("answer");
		inputComponent.handleInput("\r");
		expect(await input).toBe("answer");
		const editor = mode.showExtensionEditor("Edit", "draft");
		(flows.current!.content as ExtensionEditorComponent).handleInput("\u001b");
		expect(await editor).toBeUndefined();
		expect(flows.all).toHaveLength(0);
		expect(restoreEditor).toHaveBeenCalledTimes(2);
	});

	it("returns from a skill reader to the original selector and applies changes on close", async () => {
		const directory = mkdtempSync(join(tmpdir(), "candy-skill-reader-"));
		try {
			const skillPath = join(directory, "SKILL.md");
			writeFileSync(skillPath, "# Test skill\nUse this skill for testing.\n");
			const { mode, flows, settings, reload, restoreEditor } = createHarness();
			const paths: ResolvedPaths = {
				extensions: [],
				skills: [
					{ path: skillPath, enabled: false, metadata: { source: "auto", scope: "user", origin: "top-level" } },
				],
				prompts: [],
				themes: [],
			};
			Object.assign(Reflect.get(mode, "runtimeHost"), {
				services: { agentDir: directory },
				session: {
					history: { getCwd: () => directory },
					execution: { isStreaming: false, isCompacting: false },
					resources: {
						getConfiguration: async () => ({
							paths: { global: paths, project: paths },
							operations: new ResourceConfiguration(settings, directory, directory, paths),
						}),
					},
				},
			});
			await mode.showSkillConfiguration();
			const selectorFrame = flows.current!;
			const selector = selectorFrame.content as ConfigSelectorComponent;
			selector.handleInput(" ");
			await vi.waitFor(() => expect(settings.getGlobalSettings().skills).toBeDefined());
			selector.handleInput("\r");
			expect(flows.current!.content).toBeInstanceOf(ReadingPanelComponent);
			(flows.current!.content as ReadingPanelComponent).handleInput("\u001b");
			expect(flows.current).toBe(selectorFrame);
			expect(flows.all).toHaveLength(1);
			selector.handleInput("\u001b");
			await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
			expect(flows.all).toHaveLength(0);
			expect(restoreEditor).toHaveBeenCalledOnce();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
