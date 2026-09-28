import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createModelRegistry, getModelRuntime } from "../../model-runtime-test-utils.ts";

function modelsJson(provider: string, model: string): Record<string, unknown> {
	return {
		providers: {
			[provider]: {
				baseUrl: "https://example.test/v1",
				api: "openai-completions",
				apiKey: "test-key",
				models: [{ id: model }],
			},
		},
	};
}

describe("issue #6999 models.json hot reload", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("refreshes the Sources catalog from a changed models.json", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "candy-models-json-hot-reload-"));
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(modelsPath, JSON.stringify(modelsJson("old-provider", "old-model")));
		const runtime = getModelRuntime(await createModelRegistry(AuthStorage.inMemory(), modelsPath));
		expect(runtime.getModel("old-provider", "old-model")).toBeDefined();

		writeFileSync(modelsPath, JSON.stringify(modelsJson("new-provider", "new-model")));
		const result = await runtime.refresh({ allowNetwork: false });

		expect(result.aborted).toBe(false);
		expect(runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`)).toContain(
			"new-provider/new-model",
		);
		expect(runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`)).not.toContain(
			"old-provider/old-model",
		);
	});
});
