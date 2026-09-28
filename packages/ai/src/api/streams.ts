import type { Api, ProviderStreams } from "../types.ts";
import { anthropicMessagesApi } from "./anthropic-messages.lazy.ts";
import { azureOpenAIResponsesApi } from "./azure-openai-responses.lazy.ts";
import { bedrockConverseStreamApi } from "./bedrock-converse-stream.lazy.ts";
import { googleGenerativeAIApi } from "./google-generative-ai.lazy.ts";
import { googleVertexApi } from "./google-vertex.lazy.ts";
import { mistralConversationsApi } from "./mistral-conversations.lazy.ts";
import { openAICodexResponsesApi } from "./openai-codex-responses.lazy.ts";
import { openAICompletionsApi } from "./openai-completions.lazy.ts";
import { openAIResponsesApi } from "./openai-responses.lazy.ts";
import { piMessagesApi } from "./pi-messages.lazy.ts";

/** Returns the lazy stream implementation for a built-in API identifier. */
export function createBuiltinApiStreams(api: Api): ProviderStreams | undefined {
	switch (api) {
		case "anthropic-messages":
			return anthropicMessagesApi();
		case "azure-openai-responses":
			return azureOpenAIResponsesApi();
		case "bedrock-converse-stream":
			return bedrockConverseStreamApi();
		case "google-generative-ai":
			return googleGenerativeAIApi();
		case "google-vertex":
			return googleVertexApi();
		case "mistral-conversations":
			return mistralConversationsApi();
		case "openai-codex-responses":
			return openAICodexResponsesApi();
		case "openai-completions":
			return openAICompletionsApi();
		case "openai-responses":
			return openAIResponsesApi();
		case "pi-messages":
			return piMessagesApi();
		default:
			return undefined;
	}
}
