import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type Provider,
} from "@candy/ai";
import { afterEach, describe, expect, it } from "vitest";
import { getTestAgent } from "../../execution-internals.ts";
import { createHarness, type Harness } from "../harness.ts";

const INDIVIDUAL_BASE_URL = "https://api.individual.githubcopilot.com";
const ENTERPRISE_BASE_URL = "https://api.enterprise.githubcopilot.com";

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const model = harness.getModel();
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("assistant response to compact", { timestamp: now - 500 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	harness.sessionManager.appendMessage(assistant);
}

describe("issue #6768 Copilot compaction base URL", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
	});

	it("uses the auth-resolved base URL through the SDK-style stream wrapper", async () => {
		harness = await createHarness();
		seedCompactableSession(harness);
		const catalogModel = { ...harness.getModel(), baseUrl: INDIVIDUAL_BASE_URL };
		getTestAgent(harness.session.execution).state.model = catalogModel;

		let requestBaseUrl: string | undefined;
		const respond = (requestModel: Model<string>) => {
			requestBaseUrl = requestModel.baseUrl;
			const stream = createAssistantMessageEventStream();
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					...fauxAssistantMessage("summary"),
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
				},
			});
			return stream;
		};
		const provider: Provider<string> = {
			id: catalogModel.provider,
			name: "Copilot regression provider",
			baseUrl: INDIVIDUAL_BASE_URL,
			auth: {
				apiKey: {
					name: "Copilot token",
					resolve: async ({ credential }) =>
						credential?.key ? { auth: { apiKey: credential.key }, source: "explicit token" } : undefined,
				},
				oauth: {
					name: "Copilot OAuth",
					login: async () => {
						throw new Error("unused");
					},
					refresh: async (credential) => credential,
					toAuth: async (credential) => ({
						apiKey: credential.access,
						baseUrl: ENTERPRISE_BASE_URL,
					}),
				},
			},
			getModels: () => [catalogModel],
			stream: (requestModel) => respond(requestModel),
			streamSimple: (requestModel) => respond(requestModel),
		};

		await harness.authStorage.modify(catalogModel.provider, async () => ({
			type: "oauth",
			access: "enterprise-token",
			refresh: "refresh-token",
			expires: Date.now() + 60 * 60_000,
		}));
		const modelRuntime = harness.session.execution.modelRuntime;
		modelRuntime.registerNativeProvider(provider);
		await modelRuntime.refresh({ allowNetwork: false, providers: [catalogModel.provider] });
		getTestAgent(harness.session.execution).streamFunction = (model, context, options) =>
			modelRuntime.streamSimple(model, context, options);

		await harness.session.execution.compact();

		expect(requestBaseUrl).toBe(ENTERPRISE_BASE_URL);
	});
});
