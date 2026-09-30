import { describe, expect, it, vi } from "vitest";
import type { ImageModel, ImagesContext } from "../src/types.ts";
import { createOpenRouterImageModels } from "./openrouter-image-models.ts";

// Reproduce the openai SDK APIError shape: makeMessage(status, error, message)
// returns `"403 status code (no body)"` when status is set but the parsed body
// (`error`) is empty/unparsed, while the parsed body itself is kept on `.error`.
class FakeAPIError extends Error {
	status: number;
	error: unknown;
	constructor(status: number, parsedBody: unknown) {
		super(`${status} status code (no body)`);
		this.name = "PermissionDeniedError";
		this.status = status;
		this.error = parsedBody;
	}
}

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const promise = Promise.resolve(undefined) as unknown as {
						withResponse: () => Promise<never>;
					};
					promise.withResponse = async () => {
						// 403 from a gateway/proxy carrying the real reason in the body.
						throw new FakeAPIError(403, { error: "blocked by gateway WAF" });
					};
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

describe("provider error body passthrough", () => {
	it("surfaces the HTTP body reason instead of the opaque SDK message (openrouter images)", async () => {
		const model: ImageModel<"openrouter-images"> = {
			type: "image",
			id: "black-forest-labs/flux.2-pro",
			name: "FLUX.2 Pro",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
		};
		const context: ImagesContext = {
			input: [{ type: "text", text: "Generate a dog" }],
		};

		const request = createOpenRouterImageModels(model);
		const output = await request.models.generateImages(request.model, context, { apiKey: "test" });

		expect(output.stopReason).toBe("error");
		// The status should be surfaced.
		expect(output.errorMessage).toContain("403");
		// The body reason must not be swallowed by the opaque SDK message.
		expect(output.errorMessage).toContain("blocked by gateway WAF");
		expect(output.errorMessage).not.toBe("403 status code (no body)");
	});
});
