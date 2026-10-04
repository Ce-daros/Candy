import type { ElicitRequestParams, ElicitResult } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import type { McpInteractionRequest } from "../src/core/mcp/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function form(request: ElicitRequestParams): McpInteractionRequest {
	return { type: "elicitation", server: "fixture", request };
}

function interaction(selectors: (string | undefined)[], inputs: (string | undefined)[] = []) {
	const session = {};
	const select = vi.fn(async (_title: string, _options: string[]) => selectors.shift());
	const input = vi.fn(async (_title: string, _placeholder?: string) => inputs.shift());
	const warning = vi.fn();
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		runtimeHost: { session, subscribeSession: () => () => {} },
		showExtensionSelector: select,
		showExtensionInput: input,
		showWarning: warning,
	});
	const handler = Reflect.get(InteractiveMode.prototype, "handleMcpInteraction") as (
		this: InteractiveMode,
		request: McpInteractionRequest,
		signal?: AbortSignal,
	) => Promise<ElicitResult>;
	return { run: (request: McpInteractionRequest) => handler.call(mode, request), select, input, warning };
}

describe("MCP form elicitation", () => {
	it("maps titled single-select and multi-select labels to values, including defaults", async () => {
		const ui = interaction(["1. Blue", "2. [ ] Blue", "Done", "Submit"]);
		const result = await ui.run(
			form({
				mode: "form",
				message: "Choices",
				requestedSchema: {
					type: "object",
					properties: {
						color: {
							type: "string",
							oneOf: [
								{ const: "red", title: "Red" },
								{ const: "blue", title: "Blue" },
							],
							default: "blue",
						},
						tags: {
							type: "array",
							items: {
								anyOf: [
									{ const: "red", title: "Red" },
									{ const: "blue", title: "Blue" },
								],
							},
							default: ["red"],
							minItems: 1,
							maxItems: 2,
						},
					},
					required: ["color", "tags"],
				},
			}),
		);
		expect(result).toEqual({ action: "accept", content: { color: "blue", tags: ["red", "blue"] } });
		expect(ui.select.mock.calls[0]?.[1][0]).toBe("1. Blue");
	});

	it("enforces multi-select limits and supports an optional skip", async () => {
		const ui = interaction(["Done", "1. [ ] red", "2. [ ] blue", "Done", "Skip", "Submit"]);
		const result = await ui.run(
			form({
				mode: "form",
				message: "Tags",
				requestedSchema: {
					type: "object",
					properties: {
						tags: { type: "array", items: { type: "string", enum: ["red", "blue"] }, minItems: 1, maxItems: 1 },
						optional: { type: "array", items: { type: "string", enum: ["x"] } },
					},
					required: ["tags"],
				},
			}),
		);
		expect(result).toEqual({ action: "accept", content: { tags: ["red"] } });
		expect(ui.warning).toHaveBeenCalledTimes(2);
	});

	it("uses defaults and rejects invalid formats and numeric values before submitting", async () => {
		const ui = interaction(["Submit"], ["bad", "me@example.test", "", "1.5", "2"]);
		const result = await ui.run(
			form({
				mode: "form",
				message: "Details",
				requestedSchema: {
					type: "object",
					properties: {
						email: { type: "string", format: "email" },
						date: { type: "string", format: "date", default: "2026-10-03" },
						count: { type: "integer", minimum: 1 },
					},
					required: ["email", "date", "count"],
				},
			}),
		);
		expect(result).toEqual({ action: "accept", content: { email: "me@example.test", date: "2026-10-03", count: 2 } });
		expect(ui.warning).toHaveBeenCalledTimes(2);
	});

	it("cancels without returning partial form content", async () => {
		const ui = interaction([], ["first", undefined]);
		const result = await ui.run(
			form({
				mode: "form",
				message: "Details",
				requestedSchema: {
					type: "object",
					properties: { first: { type: "string" }, second: { type: "string" } },
					required: ["first", "second"],
				},
			}),
		);
		expect(result).toEqual({ action: "cancel" });
	});
});
