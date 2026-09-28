import type { Models, ModelsApiStreamOptions, ModelsSimpleStreamOptions } from "../src/models.ts";
import { createModels } from "../src/models.ts";
import { builtinModels } from "../src/providers/all.ts";
import { fauxProvider, type RegisterFauxProviderOptions } from "../src/providers/faux.ts";
import type { Api, AssistantMessage, Context, Model, ProviderStreamOptions } from "../src/types.ts";

const runtime = builtinModels();

export function streamBuiltin<TApi extends Api>(model: Model<TApi>, context: Context, options?: ProviderStreamOptions) {
	return runtime.stream(model, context, options as ModelsApiStreamOptions<TApi> | undefined);
}

export function completeBuiltin(
	model: Model<Api>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	return runtime.complete(model, context, options as ModelsApiStreamOptions<Api> | undefined);
}

export function streamBuiltinSimple(model: Model<Api>, context: Context, options?: ProviderStreamOptions) {
	return runtime.streamSimple(model, context, options as ModelsSimpleStreamOptions | undefined);
}

export function completeBuiltinSimple(
	model: Model<Api>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	return runtime.completeSimple(model, context, options as ModelsSimpleStreamOptions | undefined);
}

export const builtinRuntime = {
	...runtime,
	stream: streamBuiltin,
	complete: completeBuiltin,
	streamSimple: streamBuiltinSimple,
	completeSimple: completeBuiltinSimple,
} satisfies Omit<Models, "stream" | "complete" | "streamSimple" | "completeSimple"> & {
	stream: typeof streamBuiltin;
	complete: typeof completeBuiltin;
	streamSimple: typeof streamBuiltinSimple;
	completeSimple: typeof completeBuiltinSimple;
};

export function createFauxRuntime(options: RegisterFauxProviderOptions = {}) {
	const runtime = createModels();
	const faux = fauxProvider(options);
	runtime.setProvider(faux.provider);
	return { ...faux, runtime };
}
