import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

describe("interaction configuration", () => {
	it("keeps the model scope global, including an explicit empty scope, across reloads", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("project", () => JSON.stringify({ scopedModels: [{ provider: "ignored", modelId: "model" }] }));
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getScopedModels()).toBeUndefined();
		await manager.setScopedModels([]);
		await manager.flush();
		await manager.reload();
		expect(manager.getScopedModels()).toEqual([]);
		const refs = [{ provider: "offline-provider", modelId: "missing/model" }];
		await manager.setScopedModels(refs);
		refs[0].provider = "changed";
		await manager.flush();
		await manager.reload();
		expect(manager.getScopedModels()).toEqual([{ provider: "offline-provider", modelId: "missing/model" }]);
		await manager.setScopedModels(undefined);
		await manager.flush();
		await manager.reload();
		expect(manager.getScopedModels()).toBeUndefined();
	});

	it("persists default tools without giving callers the stored array", async () => {
		const storage = new InMemorySettingsStorage();
		const manager = SettingsManager.fromStorage(storage);
		const tools = ["read", "bash"];
		await manager.setDefaultTools(tools);
		tools.push("write");
		await manager.flush();
		await manager.reload();
		expect(manager.getDefaultTools()).toEqual(["read", "bash"]);
		await manager.setDefaultTools([]);
		await manager.flush();
		expect(manager.getDefaultTools()).toEqual([]);
		await manager.setDefaultTools(undefined);
		await manager.flush();
		await manager.reload();
		expect(manager.getDefaultTools()).toBeUndefined();
	});

	it("reports model thinking and compaction sources through project inheritance", async () => {
		const key = "provider/family/model";
		const model = { provider: "provider", id: "family/model" };
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				modelThinkingLevels: { [key]: "high" },
				compaction: {
					reserveTokens: 8192,
					modelOverrides: { [key]: { reserveTokens: 40000, keepRecentTokens: 30000 } },
				},
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({
				modelThinkingLevels: { [key]: "low" },
				compaction: { keepRecentTokens: 9000, modelOverrides: { [key]: { keepRecentTokens: 1000 } } },
			}),
		);
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getModelThinkingSettingWithSource(model)).toEqual({
			requested: "low",
			source: "project-model",
			savedGlobalOverride: "high",
		});
		expect(manager.getCompactionTokenSettingsWithSources(model)).toEqual({
			reserveTokens: { value: 40000, source: "global-model", savedGlobalOverride: 40000 },
			keepRecentTokens: { value: 1000, source: "project-model", savedGlobalOverride: 30000 },
		});
		await manager.setModelThinkingLevel(model.provider, model.id, "max");
		expect(manager.getModelThinkingSettingWithSource(model)).toEqual({
			requested: "low",
			source: "project-model",
			savedGlobalOverride: "max",
		});
		await manager.setModelCompactionOverride(model.provider, model.id, "reserveTokens", 2048);
		await manager.flush();
		await manager.reload();
		expect(manager.getCompactionReserveTokens(model)).toBe(2048);
		expect(manager.getCompactionTokenSettingsWithSources(model).reserveTokens.source).toBe("global-model");
		await manager.setModelCompactionOverride(model.provider, model.id, "reserveTokens", undefined);
		await manager.flush();
		await manager.reload();
		expect(manager.getCompactionReserveTokens(model)).toBe(8192);
		expect(manager.getCompactionTokenSettingsWithSources(model).reserveTokens.source).toBe("global");
		manager.setProjectTrusted(false);
		expect(manager.getModelThinkingSettingWithSource(model)).toEqual({
			requested: "max",
			source: "global-model",
			savedGlobalOverride: "max",
		});
		expect(manager.getCompactionKeepRecentTokens(model)).toBe(30000);
	});

	it("resolves inherited thinking defaults and runtime overrides without mislabeling sources", () => {
		const model = { provider: "provider", id: "model" };
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ defaultThinkingLevel: "medium" }));
		storage.withLock("project", () => JSON.stringify({ defaultThinkingLevel: "high" }));
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getModelThinkingSettingWithSource(model)).toEqual({
			requested: "high",
			source: "project",
			savedGlobalOverride: undefined,
		});
		manager.applyOverrides({ defaultThinkingLevel: "xhigh" });
		expect(manager.getModelThinkingSettingWithSource(model).source).toBe("runtime");
		manager.applyOverrides({ modelThinkingLevels: { "provider/model": "low" } });
		expect(manager.getModelThinkingSettingWithSource(model)).toEqual({
			requested: "low",
			source: "runtime-model",
			savedGlobalOverride: undefined,
		});
		manager.setProjectTrusted(false);
		expect(manager.getModelThinkingSettingWithSource(model)).toEqual({
			requested: "low",
			source: "runtime-model",
			savedGlobalOverride: undefined,
		});
	});

	it("reports runtime compaction source only when it controls the effective field", () => {
		const model = { provider: "provider", id: "model" };
		const manager = SettingsManager.inMemory({
			compaction: { reserveTokens: 8000, modelOverrides: { "provider/model": { keepRecentTokens: 3000 } } },
		});
		manager.applyOverrides({ compaction: { reserveTokens: 9000 } });
		expect(manager.getCompactionTokenSettingsWithSources(model)).toEqual({
			reserveTokens: { value: 9000, source: "runtime", savedGlobalOverride: undefined },
			keepRecentTokens: { value: 3000, source: "global-model", savedGlobalOverride: 3000 },
		});
		manager.applyOverrides({ compaction: { modelOverrides: { "provider/model": { keepRecentTokens: 4000 } } } });
		expect(manager.getCompactionTokenSettingsWithSources(model).keepRecentTokens).toEqual({
			value: 4000,
			source: "runtime-model",
			savedGlobalOverride: 3000,
		});
	});

	it("rejects invalid model compaction values before changing settings", async () => {
		const manager = SettingsManager.inMemory();
		await expect(manager.setModelCompactionOverride("p", "m", "reserveTokens", -1)).rejects.toThrow();
		expect(manager.getGlobalSettings().compaction).toBeUndefined();
	});
});
