import { type CredentialStore, InMemoryModelsStore } from "@candy/ai";
import { ModelRuntime } from "../src/core/model-runtime.ts";

/** Load optional models.json configuration without introducing file-backed catalog locks into unit tests. */
export async function createTestModelRuntime(credentials: CredentialStore, modelsPath?: string): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials,
		modelsPath,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});
}

export async function createInMemoryModelRuntime(credentials: CredentialStore): Promise<ModelRuntime> {
	return ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
}
