import { generateImages } from "../src/api/openrouter-images.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { ImageModel } from "../src/types.ts";

export function createOpenRouterImageModels(model: ImageModel<"openrouter-images">) {
	const models = createModels();
	models.setProvider(
		createProvider({
			id: model.provider,
			auth: { apiKey: { name: "Test key", resolve: async () => ({ auth: { apiKey: "test" } }) } },
			models: [model],
			images: { "openrouter-images": { generateImages } },
		}),
	);
	return { models, model: models.getModelOfType("image", model.provider, model.id)! };
}
