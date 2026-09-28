import { stripVTControlCharacters as stripAnsi } from "node:util";
import { setKeybindings } from "@candy/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { CommandPanel } from "../src/modes/interactive/components/command-panel.ts";
import { InteractivePresentation, type PresentationHost } from "../src/modes/interactive/interactive-presentation.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("interactive presentation", () => {
	let harness: Harness;
	let presentation: InteractivePresentation;
	let panel: CommandPanel;
	let host: PresentationHost;
	beforeEach(async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		harness = await createHarness({
			models: [
				{ id: "first", name: "First", reasoning: true },
				{ id: "second", name: "Second", reasoning: true },
				{ id: "plain", name: "Plain", reasoning: false },
			],
		});
		host = {
			session: () => harness.session,
			settings: () => harness.settingsManager,
			mount: (content) => {
				panel = content;
				panel.focused = true;
				panel.setAvailableHeight(30);
			},
			exit: vi.fn(),
			render: vi.fn(),
			read: vi.fn(),
			edit: vi.fn(async () => undefined),
			login: vi.fn(async () => {}),
			reload: vi.fn(async () => {}),
			skills: vi.fn(async () => {}),
			settingsActions: () => [],
			localCommands: () => [],
			historyAction: vi.fn(async () => {}),
		};
		presentation = new InteractivePresentation(host);
	});
	afterEach(() => {
		presentation.dispose();
		harness.cleanup();
	});

	async function choose(query: string): Promise<void> {
		panel.handleInput(`\x1b[200~${query}\x1b[201~`);
		panel.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();
	}

	it("saves the highlighted model default without changing the active session", async () => {
		const highlighted = harness.models[1];
		presentation.open("details", highlighted);
		expect(stripAnsi(panel.render(100).join("\n"))).toContain(`${highlighted.provider}/second`);
		await choose("Set as default");
		expect(harness.settingsManager.getDefaultModel()).toBe("second");
		expect(harness.session.model?.id).toBe("first");
	});

	it("keeps nested model settings and returns to the same Details selection", async () => {
		presentation.open("details", harness.models[1]);
		await choose("Default thinking");
		await choose("high");
		expect(harness.settingsManager.getModelThinkingLevel(harness.models[1].provider, "second")).toBe("high");
		panel.handleInput("\x1b");
		expect(panel.getQuery()).toBe("Default thinking");
		expect(panel.getSelectedId()).toBe("thinking");
		panel.handleInput("\x1b");
		expect(host.exit).toHaveBeenCalledOnce();
	});

	it("only offers Off for a model without reasoning", async () => {
		presentation.open("details", harness.models[2]);
		await choose("Default thinking");
		const lines = stripAnsi(panel.render(100).join("\n"));
		expect(lines).toContain("off");
		panel.handleInput("medium");
		expect(panel.getSelectedId()).toBeUndefined();
	});

	it("shows the inherited thinking source and model constraint", () => {
		harness.settingsManager.setDefaultThinkingLevel("high");
		presentation.open("details", harness.models[2]);
		const text = stripAnsi(panel.render(100).join("\n"));
		expect(text).toContain("Thinking: off · global (requested high)");
	});

	it("persists an empty quick selection and keeps unavailable configured identities", async () => {
		presentation.open("sources");
		await choose("Clear quick selection");
		expect(harness.settingsManager.getScopedModels()).toEqual([]);
		harness.settingsManager.setScopedModels([{ provider: "missing-provider", modelId: "missing-model" }]);
		presentation.open("sources");
		await choose("missing-provider");
		expect(stripAnsi(panel.render(100).join("\n"))).toContain("missing-model");
		expect(stripAnsi(panel.render(100).join("\n"))).toContain("Unavailable");
		expect(harness.session.model?.id).toBe("first");
	});

	it("resumes History at its selected action after a child closes", async () => {
		presentation.open("history");
		await choose("Tree");
		expect(host.historyAction).toHaveBeenCalledWith("tree", "");
		presentation.resume();
		expect(panel.getQuery()).toBe("Tree");
		expect(panel.getSelectedId()).toBe("tree");
	});

	it("leaves a rejected parameter in its input", async () => {
		presentation.open("details", harness.models[1]);
		await choose("Compaction reserve tokens");
		panel.handleInput("-1");
		panel.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();
		const lines = stripAnsi(panel.render(100).join("\n"));
		expect(lines).toContain("-1");
		expect(lines).toContain("non-negative whole number");
		expect(harness.settingsManager.getCompactionReserveTokens(harness.models[1])).toBe(16384);
	});

	it("changes Behavior through the session runtime", async () => {
		presentation.open("agent");
		await choose("Behavior");
		const previous = harness.session.steeringMode;
		await choose("Steering");
		expect(harness.session.steeringMode).not.toBe(previous);
		expect(harness.settingsManager.getSteeringMode()).toBe(harness.session.steeringMode);
	});

	it("clears one model compaction override while retaining the other", async () => {
		const model = harness.models[0];
		harness.settingsManager.setModelCompactionOverride(model.provider, model.id, "reserveTokens", 20000);
		harness.settingsManager.setModelCompactionOverride(model.provider, model.id, "keepRecentTokens", 4000);
		presentation.open("details", model);
		await choose("Use inherited reserve tokens");
		expect(harness.settingsManager.getCompactionReserveTokens(model)).toBe(16384);
		expect(harness.settingsManager.getCompactionKeepRecentTokens(model)).toBe(4000);
	});

	it("toggles and selects matching provider models without changing other sources or the session", async () => {
		const provider = harness.models[0].provider;
		const unavailable = { provider: "missing-provider", modelId: "saved-model" };
		harness.settingsManager.setScopedModels([unavailable]);
		presentation.open("sources");
		await choose(harness.session.modelRuntime.getProvider(provider)!.name);
		panel.handleInput("First");
		panel.handleInput("\x1b[B");
		panel.handleInput(" ");
		await Promise.resolve();
		expect(harness.settingsManager.getScopedModels()).toEqual([unavailable, { provider, modelId: "first" }]);
		panel.handleInput("\x04");
		expect(harness.settingsManager.getScopedModels()).toEqual([unavailable]);
		panel.handleInput("\x01");
		expect(harness.settingsManager.getScopedModels()).toEqual([unavailable, { provider, modelId: "first" }]);
		expect(harness.session.model?.id).toBe("first");
		panel.handleInput("\x1b");
		await choose("");
		await choose("Select all provider models");
		expect(harness.settingsManager.getScopedModels()).toEqual([
			unavailable,
			...harness.models.map((model) => ({ provider, modelId: model.id })),
		]);
	});

	it("keeps automatic scope when bulk keys have no matches", async () => {
		harness.settingsManager.setScopedModels(undefined);
		presentation.open("sources");
		await choose(harness.session.modelRuntime.getProvider(harness.models[0].provider)!.name);
		panel.handleInput("no-such-model");
		panel.handleInput("\x01");
		panel.handleInput("\x04");
		expect(harness.settingsManager.getScopedModels()).toBeUndefined();
	});

	it("only offers removal for a stored provider credential", async () => {
		const runtime = harness.session.modelRuntime;
		const provider = harness.models[0].provider;
		const list = vi.spyOn(runtime, "listCredentials").mockResolvedValue([]);
		presentation.open("sources");
		await choose(runtime.getProvider(provider)!.name);
		await Promise.resolve();
		expect(stripAnsi(panel.render(100).join("\n"))).not.toContain("Remove saved credentials");
		list.mockResolvedValue([{ providerId: provider, type: "api_key" }]);
		presentation.open("sources");
		await choose(runtime.getProvider(provider)!.name);
		await Promise.resolve();
		expect(stripAnsi(panel.render(100).join("\n"))).toContain("Remove saved credentials");
		list.mockRestore();
	});

	it("clears saved default tools without altering the current session tools", async () => {
		harness.settingsManager.setDefaultTools([]);
		const tools = harness.session.getActiveToolNames();
		presentation.open("agent");
		await choose("Tools");
		await choose("Use inherited default tools");
		expect(harness.settingsManager.getGlobalSettings().defaultTools).toBeUndefined();
		expect(harness.session.getActiveToolNames()).toEqual(tools);
	});

	it("prefills Rename with the current session name", async () => {
		harness.session.setSessionName("Research notes");
		presentation.open("history");
		await choose("Rename");
		expect(stripAnsi(panel.render(100).join("\n"))).toContain("> Research notes");
	});
});
