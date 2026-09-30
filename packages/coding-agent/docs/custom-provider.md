# Custom Providers

A provider extension connects Candy to a model service that needs custom authentication, discovery, refresh, or streaming. Use [`models.json`](models.md#configure-a-compatible-endpoint) when the service already speaks a supported API and only needs model or endpoint configuration.

Provider extensions run inside Candy and can inspect credentials, prompts, tool definitions, responses, and usage. Load them only from sources you trust.

## Register a provider

Register a native `Provider` from `@candy/ai` in the extension factory:

```typescript
import type { ExtensionAPI } from "@candy/coding-agent";
import type { Provider } from "@candy/ai";

const provider: Provider = {
	id: "company-ai",
	name: "Company AI",
	baseUrl: "https://ai.example.com/v1",
	auth: {
		apiKey: {
			name: "API key",
			login: async (interaction) => ({
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Company AI API key" }),
			}),
		},
	},
	getModels: () => [],
	stream: (model, context, options) => companyStream(model, context, options),
};

export default function (candy: ExtensionAPI) {
	candy.registerProvider(provider);
}
```

The factory may be asynchronous. Candy installs providers registered during setup before startup model selection. A registration made by a later command or event handler takes effect in the active runtime. `candy.unregisterProvider(provider.id)` removes that runtime registration and restores the built-in provider if one used the same ID.

Provider implementations own model discovery, authentication, refresh, request conversion, streaming, and image operations. See the native [`Provider` contract](../../ai/src/models.ts) and existing implementations under [`packages/ai/src/providers`](../../ai/src/providers).

`models.json` remains the configuration path for compatible endpoints, API keys, headers, model additions, model overrides, and compatibility flags. Its configured values apply over built-in or registered native providers.

## Extend a supported API

Reuse Candy's API implementation when the service follows an existing protocol. A native provider can supply authentication, endpoint information, model filtering, and catalog refresh while delegating request conversion and streaming to a compatible API provider.

Compatibility flags describe verified differences in an otherwise supported protocol. Do not enable them only because a service claims compatibility.

## Implement streaming

Implement a provider stream only when no existing API implementation can represent the service. Study the implementations under [`packages/ai/src/api`](../../ai/src/api) first.

A provider stream must create a valid assistant message, emit balanced content and tool-call events, finalize usage and stop reason, emit one terminal `done` or `error` event, close the stream, and honor cancellation. Request setup may fail before the first `start` event. Report context overflow only when the service actually rejected the request for context length; Candy owns recovery and retry scheduling.

## Test the integration

Test ordinary and empty responses, tool calls and results, supported image operations, usage and cost, cancellation, overflow, malformed streams, Unicode boundaries, cross-provider session restore, authentication refresh, and refresh cancellation. Use faux providers and isolated credentials; do not use real user credentials or paid model calls.
