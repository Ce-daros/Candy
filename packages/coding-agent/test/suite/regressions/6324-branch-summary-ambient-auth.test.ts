import { fauxAssistantMessage } from "@candy/ai";
import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #6324 branch summary ambient auth", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("summarizes tree branches when request auth has no API key", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			models: [{ id: "faux-1", reasoning: true, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
		});
		harnesses.push(harness);

		let ambientAuthResolved = 0;
		harness.session.execution.modelRuntime.registerNativeProvider({
			...harness.faux.provider,
			auth: {
				apiKey: {
					name: "Ambient test credentials",
					resolve: async () => {
						ambientAuthResolved++;
						return { auth: {}, source: "ambient test credentials" };
					},
				},
			},
		});
		await harness.session.execution.modelRuntime.refresh({ allowNetwork: false });
		harness.session.selection.setThinkingLevel("high");
		harness.setResponses([
			(_context, requestOptions) => {
				expect(requestOptions?.apiKey).toBeUndefined();
				expect(requestOptions?.reasoning).toBe("high");
				expect(requestOptions?.resourceOwner).toBeDefined();
				return fauxAssistantMessage("branch summary text");
			},
		]);

		const targetId = harness.sessionManager.appendMessage(userMsg("first branch"));
		harness.sessionManager.appendMessage(assistantMsg("first reply"));
		harness.sessionManager.appendMessage(userMsg("abandoned branch work"));
		harness.sessionManager.appendMessage(assistantMsg("abandoned reply"));

		const result = await harness.session.execution.navigateTree(targetId, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
		expect(ambientAuthResolved).toBeGreaterThan(0);
		expect(result.summaryEntry?.type).toBe("branch_summary");
		expect(result.summaryEntry?.summary).toContain("branch summary text");
		expect(result.summaryEntry?.usage?.input).toBeGreaterThan(0);
	});
});
