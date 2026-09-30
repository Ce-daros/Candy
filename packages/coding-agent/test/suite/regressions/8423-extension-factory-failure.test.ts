import { builtinProviders } from "@candy/ai/providers/all";
import { describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

const baseProvider = builtinProviders().find((provider) => provider.id === "anthropic");
if (!baseProvider) throw new Error("Anthropic provider is missing");

function providerWithId(id: string) {
	if (!baseProvider) throw new Error("Anthropic provider is missing");
	return { ...baseProvider, id };
}

describe("issue #8423 extension factory failure", () => {
	it("discards runtime changes and disables the failed API", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		let capturedApi: ExtensionAPI | undefined;
		let eventCalls = 0;
		let flagDuringLoad: boolean | string | undefined;

		await loadExtensionFromFactory(
			(candy) => candy.registerProvider(providerWithId("working-provider")),
			process.cwd(),
			eventBus,
			runtime,
			"<working>",
		);
		await expect(
			loadExtensionFromFactory(
				(candy) => {
					capturedApi = candy;
					candy.events.on("factory-failure", () => {
						eventCalls++;
					});
					candy.registerFlag("failed-flag", { type: "boolean", default: true });
					flagDuringLoad = candy.getFlag("failed-flag");
					candy.unregisterProvider("working-provider");
					candy.registerProvider(providerWithId("failed-provider"));
					throw new Error("factory failed");
				},
				process.cwd(),
				eventBus,
				runtime,
				"<failing>",
			),
		).rejects.toThrow("factory failed");

		eventBus.emit("factory-failure", undefined);
		expect(flagDuringLoad).toBe(true);
		expect(runtime.flagValues.has("failed-flag")).toBe(false);
		expect(runtime.pendingProviderRegistrations.map(({ provider }) => provider.id)).toEqual(["working-provider"]);
		expect(eventCalls).toBe(0);
		expect(capturedApi).toBeDefined();
		expect(() => capturedApi?.registerFlag("late-flag", { type: "boolean", default: true })).toThrow(
			'Extension "<failing>" failed to load and its API is no longer active.',
		);
	});

	it("does not discard a concurrently loaded factory's provider", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		let releaseFailure!: () => void;
		const waitBeforeFailure = new Promise<void>((resolve) => {
			releaseFailure = resolve;
		});
		const failingLoad = loadExtensionFromFactory(
			async (candy) => {
				candy.registerProvider(providerWithId("failed-provider"));
				await waitBeforeFailure;
				throw new Error("factory failed");
			},
			process.cwd(),
			eventBus,
			runtime,
			"<failing>",
		);

		await loadExtensionFromFactory(
			(candy) => candy.registerProvider(providerWithId("working-provider")),
			process.cwd(),
			eventBus,
			runtime,
			"<working>",
		);
		releaseFailure();

		await expect(failingLoad).rejects.toThrow("factory failed");
		expect(runtime.pendingProviderRegistrations.map(({ provider }) => provider.id)).toEqual(["working-provider"]);
	});
});
