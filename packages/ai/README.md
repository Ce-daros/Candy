# @candy/ai

Provider collections for chat and image models, with authentication, streaming, tools, and usage accounting. Providers own catalogs and credentials; API implementations handle their wire protocols. Chat catalogs include tool-capable models.

```bash
npm install @candy/ai
```

## Start

This example uses a scripted provider without credentials or network:

```typescript
import { createModels, type Context } from "@candy/ai";
import { fauxAssistantMessage, fauxProvider } from "@candy/ai/providers/faux";

const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage("Hello.")]);
const models = createModels();
models.setProvider(faux.provider);
const context: Context = {
  messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};
const stream = models.streamSimple(faux.getModel(), context);
for await (const event of stream) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}
const result = await stream.result();
console.log(result.stopReason, result.usage);
```

For a hosted model, register its factory from `@candy/ai/providers/<provider>`, select a model, and configure the provider's credentials. `builtinModels()` from `@candy/ai/providers/all` registers the full built-in set. A collection resolves authentication before dispatch.

## References

- [Models and authentication](docs/models.md): catalogs, credential stores, OAuth, headers, and cancellation
- [Streaming and tools](docs/streaming.md): events, tool validation, reasoning, failures, and transcript replay
- [Provider integration](docs/providers.md): custom protocols, endpoint compatibility, browser and bundle behavior
- [Images](docs/images.md): image input and generation

Types are defined in [types.ts](src/types.ts); collection and provider contracts are in [models.ts](src/models.ts). TypeBox's `Type`, `Static`, and `TSchema` are re-exported. Candy's agent loop and tool execution are supplied by [agent-core](../agent/README.md).

## Development

Use the repository [provider workflow](../../.candy/skills/add-llm-provider.md) when adding a native provider. Model data is tracked; refresh it explicitly through the generator rather than editing generated catalogs. Follow [AGENTS.md](../../AGENTS.md) for dependencies and validation.

## License

MIT
