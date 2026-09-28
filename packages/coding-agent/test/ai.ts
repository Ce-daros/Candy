import type { Api, Model, SimpleStreamOptions, TranscriptContext } from "@candy/ai";
import { createBuiltinApiStreams } from "@candy/ai/api/streams";
import { type BuiltinProvider, getBuiltinModels } from "@candy/ai/providers/all";
import type { FauxProviderHandle } from "@candy/ai/providers/faux";

export function getTestModel(provider: BuiltinProvider, modelId: string): Model<Api> {
	const model = getBuiltinModels(provider).find((candidate) => candidate.id === modelId);
	if (!model) throw new Error(`Unknown builtin model: ${provider}/${modelId}`);
	return model;
}

export function streamBuiltinSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
	const streams = createBuiltinApiStreams(model.api);
	if (!streams) throw new Error(`Unknown builtin API: ${model.api}`);
	return streams.streamSimple(model, context, options);
}

export function configuredFauxProvider(faux: FauxProviderHandle) {
	return {
		...faux.provider,
		auth: {
			apiKey: {
				name: "Faux",
				resolve: async () => ({ auth: { apiKey: "faux-key" }, source: "test" }),
			},
		},
	};
}
