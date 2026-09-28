import { stream as streamAnthropic, streamSimple as streamAnthropicSimple } from "../src/api/anthropic-messages.ts";
import {
	stream as streamAzureOpenAIResponses,
	streamSimple as streamAzureOpenAIResponsesSimple,
} from "../src/api/azure-openai-responses.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import {
	stream as streamOpenAICompletions,
	streamSimple as streamOpenAICompletionsSimple,
} from "../src/api/openai-completions.ts";
import {
	stream as streamOpenAIResponses,
	streamSimple as streamOpenAIResponsesSimple,
} from "../src/api/openai-responses.ts";
import { builtinModels } from "../src/providers/all.ts";
import type { Api, Context, Model, ProviderStreamOptions, ProviderStreams } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const streams: Partial<Record<Api, ProviderStreams>> = {
	"anthropic-messages": { stream: streamAnthropic, streamSimple: streamAnthropicSimple },
	"bedrock-converse-stream": { stream: streamBedrock, streamSimple: streamBedrock },
	"azure-openai-responses": { stream: streamAzureOpenAIResponses, streamSimple: streamAzureOpenAIResponsesSimple },
	"openai-completions": { stream: streamOpenAICompletions, streamSimple: streamOpenAICompletionsSimple },
	"openai-responses": { stream: streamOpenAIResponses, streamSimple: streamOpenAIResponsesSimple },
};
const runtime = builtinModels();

function apiFor(model: Model<Api>): ProviderStreams {
	const provider = runtime.getProvider(model.provider);
	const providerModels = provider?.getModels() ?? [];
	if (provider && (providerModels.length === 0 || providerModels.some((entry) => entry.api === model.api))) {
		return provider;
	}
	const implementation = streams[model.api];
	if (!implementation) throw new Error(`No test API stream registered for ${model.api}`);
	return implementation;
}

export function streamApi(model: Model<Api>, context: Context, options?: ProviderStreamOptions) {
	return apiFor(model).stream(model, normalizeContext(context), options);
}

export function streamApiSimple(model: Model<Api>, context: Context, options?: ProviderStreamOptions) {
	return apiFor(model).streamSimple(model, normalizeContext(context), options);
}
