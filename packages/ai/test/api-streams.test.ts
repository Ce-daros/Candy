import { describe, expect, it } from "vitest";
import { createBuiltinApiStreams } from "../src/api/streams.ts";

describe("built-in API streams", () => {
	it("returns lazy stream implementations for every known chat API", () => {
		for (const api of [
			"anthropic-messages",
			"google-generative-ai",
			"google-vertex",
			"mistral-conversations",
			"openai-codex-responses",
			"openai-completions",
			"openai-responses",
			"pi-messages",
		] as const) {
			const streams = createBuiltinApiStreams(api);
			expect(streams?.stream).toBeTypeOf("function");
			expect(streams?.streamSimple).toBeTypeOf("function");
		}
	});

	it("returns undefined for API identifiers without a built-in implementation", () => {
		expect(createBuiltinApiStreams("extension-custom-api")).toBeUndefined();
	});
});
