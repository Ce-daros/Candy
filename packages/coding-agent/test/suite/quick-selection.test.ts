import { fauxAssistantMessage } from "@candy/ai";
import { afterEach, describe, expect, it } from "vitest";
import { getQuickSelectionModels, reconcileQuickSelection } from "../../src/core/quick-selection.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("quick selection reconciliation", () => {
	const harnesses: Harness[] = [];
	const create = async (options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
			...options,
		});
		harnesses.push(harness);
		return harness;
	};

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("uses available snapshot order and keeps unavailable configured references", async () => {
		const harness = await create({ settings: { scopedModels: undefined } });
		harness.settingsManager.setScopedModels([
			{ provider: "faux", modelId: "faux-3" },
			{ provider: "faux", modelId: "missing" },
			{ provider: "faux", modelId: "faux-2" },
		]);

		expect(getQuickSelectionModels(harness.session).map((model) => model.id)).toEqual(["faux-2", "faux-3"]);
		expect(harness.settingsManager.getScopedModels()).toEqual([
			{ provider: "faux", modelId: "faux-3" },
			{ provider: "faux", modelId: "missing" },
			{ provider: "faux", modelId: "faux-2" },
		]);
	});

	it("preserves the current model when it remains selected", async () => {
		const harness = await create();
		harness.settingsManager.setScopedModels([{ provider: "faux", modelId: "faux-1" }]);

		expect(await reconcileQuickSelection(harness.session)).toBe("unchanged");
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toHaveLength(0);
	});

	it("selects the first available model when the current one was removed", async () => {
		const harness = await create();
		harness.settingsManager.setScopedModels([
			{ provider: "faux", modelId: "faux-3" },
			{ provider: "faux", modelId: "faux-2" },
		]);

		expect(await reconcileQuickSelection(harness.session)).toBe("selected");
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.settingsManager.getDefaultModel()).toBeUndefined();
	});

	it("clears the active model when no selected model is available without writing transcript or defaults", async () => {
		const harness = await create();
		harness.settingsManager.setScopedModels([{ provider: "faux", modelId: "missing" }]);

		expect(await reconcileQuickSelection(harness.session)).toBe("empty");
		expect(harness.session.model).toBeUndefined();
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toHaveLength(0);
		expect(harness.settingsManager.getScopedModels()).toEqual([{ provider: "faux", modelId: "missing" }]);
		expect(harness.settingsManager.getDefaultModel()).toBeUndefined();
	});

	it("leaves the model cleared and surfaces authentication failure instead of falling back", async () => {
		const harness = await create();
		harness.settingsManager.setScopedModels([{ provider: "faux", modelId: "faux-2" }]);
		harness.session.modelRuntime.checkAuth = async () => undefined;

		await expect(reconcileQuickSelection(harness.session)).rejects.toThrow();
		expect(harness.session.model).toBeUndefined();
	});

	it("honors an already-aborted signal before changing the model", async () => {
		const harness = await create();
		harness.settingsManager.setScopedModels([{ provider: "faux", modelId: "faux-2" }]);
		const controller = new AbortController();
		controller.abort();

		await expect(reconcileQuickSelection(harness.session, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("does not apply a model when authentication resolves after cancellation", async () => {
		const harness = await create();
		let finishAuth!: () => void;
		const auth = new Promise<void>((resolve) => {
			finishAuth = resolve;
		});
		harness.session.modelRuntime.checkAuth = async () => {
			await auth;
			return { type: "api_key", source: "test" };
		};
		const controller = new AbortController();
		const settingModel = harness.session.setModel(harness.getModel("faux-2")!, { signal: controller.signal });
		controller.abort();
		finishAuth();

		await expect(settingModel).rejects.toMatchObject({ name: "AbortError" });
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("rejects reconciliation for a disposed session", async () => {
		const harness = await create();
		harness.session.dispose();

		await expect(reconcileQuickSelection(harness.session)).rejects.toThrow("disposed");
	});

	it("rejects reconciliation while a response is running", async () => {
		const harness = await create();
		harness.settingsManager.setScopedModels([{ provider: "faux", modelId: "faux-2" }]);
		let markStarted!: () => void;
		let finishResponse!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const response = new Promise<void>((resolve) => {
			finishResponse = resolve;
		});
		harness.setResponses([
			async () => {
				markStarted();
				await response;
				return fauxAssistantMessage("done");
			},
		]);
		const prompt = harness.session.prompt("hello");
		await started;

		await expect(reconcileQuickSelection(harness.session)).rejects.toThrow("busy");
		expect(harness.session.model?.id).toBe("faux-1");
		finishResponse();
		await prompt;
	});
});
