import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

interface CapturedRequest {
	url: string;
	headers: Headers;
}

function createCapturingFetch(): { fetch: typeof globalThis.fetch; requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push({ url: request.url, headers: request.headers });
		const chunk = {
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "test",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		};
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	return { fetch, requests };
}

async function createCloudflareRuntime(): Promise<ModelRuntime> {
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("cloudflare-ai-gateway", async () => ({
		type: "api_key",
		key: "test-token",
		env: {
			CLOUDFLARE_ACCOUNT_ID: "test-account",
			CLOUDFLARE_GATEWAY_ID: "test-gateway",
		},
	}));
	return ModelRuntime.create({ credentials: authStorage, modelsPath: null });
}

const CLOUDFLARE_COMPAT_URL = "https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/compat/chat/completions";

describe("ModelRuntime Cloudflare compat streaming", () => {
	it("materializes the Cloudflare endpoint through ModelRuntime streaming", async () => {
		const modelRuntime = await createCloudflareRuntime();
		const model = modelRuntime.getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6");
		expect(model).toBeDefined();

		const { fetch, requests } = createCapturingFetch();
		const result = await modelRuntime.completeSimple(model!, { messages: [] }, { fetch });

		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe(CLOUDFLARE_COMPAT_URL);
		expect(requests[0].headers.get("cf-aig-authorization")).toBe("Bearer test-token");
	});

	it("materializes the Cloudflare endpoint after explicit auth resolution", async () => {
		const modelRuntime = await createCloudflareRuntime();
		const model = modelRuntime.getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6");
		expect(model).toBeDefined();

		const auth = await modelRuntime.getAuth(model!);
		expect(auth).toBeDefined();
		expect(auth!.auth.headers).toMatchObject({
			"cf-aig-authorization": "Bearer test-token",
			Authorization: null,
			"x-api-key": null,
		});

		const { fetch, requests } = createCapturingFetch();
		const result = await modelRuntime.completeSimple(model!, { messages: [] }, { ...auth!.auth, fetch });

		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe(CLOUDFLARE_COMPAT_URL);
		expect(requests[0].headers.get("cf-aig-authorization")).toBe("Bearer test-token");
		expect(requests[0].headers.has("authorization")).toBe(false);
		expect(requests[0].headers.has("x-api-key")).toBe(false);
	});
});
