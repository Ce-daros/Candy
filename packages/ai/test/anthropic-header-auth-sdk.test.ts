import { describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/anthropic-messages.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const defaultCredentials = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk/lib/credentials/credential-chain.mjs", () => ({
	defaultCredentials,
	resolveCredentialsFromConfig: vi.fn(),
}));

describe("Anthropic SDK header-owned authentication", () => {
	it("does not resolve the SDK credential chain when Candy supplies authentication headers", async () => {
		const model: Model<"anthropic-messages"> = {
			id: "test",
			name: "Test",
			api: "anthropic-messages",
			provider: "test",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gateway-token");
			return new Response(
				'event: message_start\ndata: {"type":"message_start","message":{"id":"msg","model":"test","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
					'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n' +
					'event: message_stop\ndata: {"type":"message_stop"}\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const result = await stream(
			model,
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] }),
			{
				headers: { Authorization: "Bearer gateway-token" },
				fetch: fetchMock,
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(defaultCredentials).not.toHaveBeenCalled();
	});
});
