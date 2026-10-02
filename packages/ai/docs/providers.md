# Provider integration

### createProvider()

`createProvider()` builds a provider from parts: identity, auth, a model list, and an API implementation (`api` for chat models, `images` for image generation; at least one is required, see [Images](images.md)). Use it for local inference servers, proxies, or any OpenAI/Anthropic-compatible endpoint:

```typescript
import { createModels, createProvider, envApiKeyAuth, type Model } from '@candy/ai';
import { openAICompletionsApi } from '@candy/ai/api/openai-completions.lazy';

const ollamaModel: Model<'openai-completions'> = {
  id: 'llama-3.1-8b',
  name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000
};

const ollama = createProvider({
  id: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  // Every provider declares auth; keyless local servers resolve as configured with no key.
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
  models: [ollamaModel],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(ollama);

await models.complete(models.getModel('ollama', 'llama-3.1-8b')!, context);
```

For providers with real keys, `envApiKeyAuth(displayName, envVars)` gives the standard behavior (stored credential wins, then the first set env var):

```typescript
const proxy = createProvider({
  id: 'my-proxy',
  auth: { apiKey: envApiKeyAuth('My proxy API key', ['MY_PROXY_API_KEY']) },
  models: [/* ... */],
  api: openAICompletionsApi(),
});
```

Mixed-API providers pass a map keyed by `model.api`; each model dispatches to its API's implementation:

```typescript
import { anthropicMessagesApi } from '@candy/ai/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@candy/ai/api/openai-responses.lazy';

const gateway = createProvider({
  id: 'my-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* models with api: 'anthropic-messages' or 'openai-responses' */],
  api: {
    'anthropic-messages': anthropicMessagesApi(),
    'openai-responses': openAIResponsesApi(),
  },
});
```

Provider-wide endpoint or request transformations belong in the provider's API implementation: wrap the `ProviderStreams` you pass as `api` so every request goes through the transformation before dispatch. The Cloudflare providers do this to materialize account/gateway endpoint placeholders from the resolved provider env:

```typescript
function tenantStreams(streams: ProviderStreams): ProviderStreams {
  const withTenant = (model: Model<Api>) => ({ ...model, baseUrl: model.baseUrl.replace('{tenant}', tenantId) });
  return {
    stream: (model, context, options) => streams.stream(withTenant(model), context, options),
    streamSimple: (model, context, options) => streams.streamSimple(withTenant(model), context, options),
  };
}

const tenantGateway = createProvider({
  id: 'tenant-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* ... */],
  api: tenantStreams(openAICompletionsApi()),
});
```

Dynamic catalogs use `fetchModels(context)` and `await models.refresh()`. The factory handles publication and persistence. Handwritten providers implement `refreshModels(context)` with transactional publication. See [Refresh](models.md#refresh) for cancellation, stores, and generation checks.

Custom models can carry `headers` (e.g. proxies behind bot detection) and `compat` flags. `Models.getAuth(model)` includes those model headers, and stream methods merge them before explicit request headers and `transformHeaders`. See [OpenAI Compatibility Settings](#openai-compatibility-settings).

Some OpenAI-compatible servers do not understand the `developer` role used for reasoning-capable models. For those providers, set `compat.supportsDeveloperRole` to `false` so the system prompt is sent as a `system` message instead. If the server also does not support `reasoning_effort`, set `compat.supportsReasoningEffort` to `false` too. This commonly applies to Ollama, vLLM, SGLang, and similar OpenAI-compatible servers.

Use model-level `thinkingLevelMap` to describe model-specific thinking controls. Keys are candy thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Missing standard levels through `high` use provider defaults; `xhigh` and `max` are opt-in and require a non-null map entry. String values are sent to the provider, `null` marks a level unsupported, and maps may skip levels.

```typescript
const ollamaReasoningModel: Model<'openai-completions'> = {
  id: 'gpt-oss:20b',
  name: 'GPT-OSS 20B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32000,
  thinkingLevelMap: {
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  }
};
```

### Calling API Implementations Directly

The API implementations are importable on their own. Each chat implementation exposes `stream` and `streamSimple` with that API's full option typing. Direct calls bypass provider auth and context normalization — pass `apiKey` explicitly and wrap the context in `normalizeContext()`:

```typescript
import { normalizeContext } from '@candy/ai';
import { stream } from '@candy/ai/api/anthropic-messages';

const s = stream(claudeModel, normalizeContext(context), {
  apiKey: process.env.ANTHROPIC_API_KEY,
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048,
});
```

Built-in API implementations live under `./api/<api-id>`:

| API id | Options type |
|--------|--------------|
| `anthropic-messages` | `AnthropicOptions` |
| `openai-completions` | `OpenAICompletionsOptions` |
| `openai-responses` | `OpenAIResponsesOptions` |
| `openai-codex-responses` | `OpenAICodexResponsesOptions` |
| `google-generative-ai` | `GoogleOptions` |
| `google-vertex` | `GoogleVertexOptions` |
| `mistral-conversations` | `MistralOptions` |

Importing an implementation module loads its SDK. The `./api/<id>.lazy` wrappers (used by the provider factories) defer that load to the first request when the runtime or bundler supports dynamic import chunking. Legacy raw API subpaths from older releases (`./anthropic`, `./google`, `./mistral`, `./openai-completions`, ...) were removed; use `@candy/ai/api/<api-id>`.

### OpenAI Compatibility Settings

The `openai-completions` API is implemented by many providers with minor differences. By default, the library auto-detects compatibility settings based on `baseUrl` for a small set of known OpenAI-compatible providers (Cerebras, xAI, Chutes, DeepSeek, NVIDIA NIM, Together AI, zAi, OpenCode, Cloudflare Workers AI, etc.). For custom proxies or unknown endpoints, you can override these settings via the `compat` field. For `openai-responses` models, the compat field supports Responses-specific flags.

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;           // Whether provider supports the `store` field (default: true)
  supportsDeveloperRole?: boolean;   // Whether provider supports `developer` role vs `system` (default: true)
  supportsReasoningEffort?: boolean; // Whether provider supports `reasoning_effort` (default: true)
  supportsUsageInStreaming?: boolean; // Whether provider supports `stream_options: { include_usage: true }` (default: true)
  supportsStrictMode?: boolean;      // Whether provider supports `strict` in tool definitions (default: false; enabled in metadata for capable built-in models)
  supportsOpenAIGrammarTools?: boolean; // Whether to emit OpenAI custom Lark/regex grammar tools; false falls back to normal function tools (default: false; the generated catalog enables it for capable models)
  supportsMidConvoSystemMessages?: boolean; // Whether the model accepts system messages after the conversation started; false folds them into the leading prompt (default: false; the generated catalog enables it for verified models)
  supportsMidConvoToolAdditions?: boolean; // Whether system messages can add tools mid-conversation via Kimi-style `tools` system messages; requires supportsMidConvoSystemMessages (default: false)
  sendSessionAffinityHeaders?: boolean; // Send session-affinity data from `sessionId` (default: true for OpenRouter, false otherwise)
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // Format for session affinity: 'openai' uses `prompt_cache_key`, `session_id`, `x-client-request-id`, and `x-session-affinity`; 'openai-nosession' uses `prompt_cache_key`, `x-client-request-id`, and `x-session-affinity`; 'openrouter' uses `x-session-id` (default: auto-detected)
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // Which field name to use (default: max_completion_tokens)
  requiresToolResultName?: boolean;  // Whether tool results require the `name` field (default: false)
  requiresAssistantAfterToolResult?: boolean; // Whether tool results must be followed by an assistant message (default: false)
  requiresThinkingAsText?: boolean;  // Whether thinking blocks must be converted to text (default: false)
  requiresReasoningContentOnAssistantMessages?: boolean; // Whether all replayed assistant messages must include empty reasoning_content when reasoning is enabled (default: auto-detected for DeepSeek)
  thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'zai' | 'qwen' | 'chat-template' | 'qwen-chat-template' | 'string-thinking'; // Format for reasoning parameters; default: openai
  chatTemplateKwargs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean }>; // chat_template_kwargs values; use $var for candy-controlled thinking values
  thinkingTokenBudgetField?: 'thinking_token_budget' | 'thinking_budget' | 'thinking_budget_tokens'; // Top-level field that caps reasoning tokens from thinkingBudgets (vLLM / Qwen / llama.cpp). Off by default.
  supportsThinkingTokenBudget?: boolean; // Alias for thinkingTokenBudgetField: 'thinking_token_budget' (vLLM). Prefer thinkingTokenBudgetField. Default: false.
  cacheControlFormat?: 'anthropic';  // Anthropic-style cache_control on system prompt, last tool, and last user/assistant text content
  openRouterRouting?: OpenRouterRouting; // OpenRouter routing preferences (default: {})
  vercelGatewayRouting?: VercelGatewayRouting; // Vercel AI Gateway routing preferences (default: {})
}

interface OpenAIResponsesCompat {
  supportsDeveloperRole?: boolean;   // Whether provider supports `developer` role vs `system` (default: true)
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // Session-affinity header format: 'openai' sends `session_id` and `x-client-request-id`; 'openai-nosession' sends `x-client-request-id`; 'openrouter' sends `x-session-id`. Does not affect the `prompt_cache_key` body param (default: auto-detected)
  supportsLongCacheRetention?: boolean; // Whether provider supports `prompt_cache_retention: "24h"` (default: true)
  supportsStrictMode?: boolean;      // Whether provider supports strict JSON-schema function tools (default: false; enabled in metadata for built-in OpenAI models)
  supportsOpenAIGrammarTools?: boolean; // Whether to emit OpenAI custom Lark/regex grammar tools; false falls back to normal function tools (default: false; the generated catalog enables it for capable models)
}
```

OpenRouter requests send `x-session-id` from `sessionId` when prompt caching is enabled. Chat Completions and Anthropic Messages both auto-detect OpenRouter endpoints unless `sendSessionAffinityHeaders` is explicitly false. On Anthropic-compatible models, `sessionAffinityFormat: "openrouter"` selects `x-session-id`; when unset, the existing `x-session-affinity` format is used. Explicit request headers take precedence over generated headers.

If `compat` is not set, the library falls back to URL-based detection. If `compat` is partially set, unspecified fields use the detected defaults. This is useful for:

- **LiteLLM proxies**: May not support `store` field
- **Custom inference servers**: May use non-standard field names
- **Self-hosted endpoints**: May have different feature support

## Browser Usage

The library supports browser environments. The core entrypoint and provider factories are side-effect free and bundle cleanly. Environment variables are not available in browsers, so pass API keys explicitly — or inject a `CredentialStore` (e.g. localStorage-backed) and let provider auth resolve from stored credentials:

```typescript
import { createModels } from '@candy/ai';
import { anthropicProvider } from '@candy/ai/providers/anthropic';

const models = createModels();
models.setProvider(anthropicProvider());

const model = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const response = await models.complete(model, {
  messages: [{ role: 'user', content: 'Hello!', timestamp: Date.now() }]
}, {
  apiKey: 'your-api-key'
});
```

> **Security Warning**: Exposing API keys in frontend code is dangerous. Anyone can extract and abuse your keys. Only use this approach for internal tools or demos. For production applications, use a backend proxy that keeps your API keys secure.

Browser compatibility notes:

- OAuth login flows are Node-only. They are lazy-loaded behind bundler-opaque imports, so registering an OAuth-capable provider does not pull Node-only code into a browser bundle — only actually logging in would.
- Use a server-side proxy or backend service if you need OAuth-based auth from a web app.

## Bundling and Tree Shaking

For small bundles, import only the providers you need:

```typescript
import { createModels } from '@candy/ai';
import { openaiProvider } from '@candy/ai/providers/openai';

const models = createModels();
models.setProvider(openaiProvider());
```

Rules:

- `@candy/ai` is the core entrypoint and does not import built-in catalogs, provider factories, or SDK implementations.
- `@candy/ai/providers/<provider>` imports that provider's catalog and lazy API wrapper only.
- `@candy/ai/providers/all` imports every built-in provider factory and all catalogs. Use it only when you want the full built-in set.
- With code splitting, provider SDKs stay in lazy chunks and load on first request.
- Without code splitting, bundlers fold reachable lazy API implementations into the single bundle. A single-provider bundle then includes that provider's SDK; `providers/all` includes all statically visible SDKs.
- Importing `@candy/ai/api/<api-id>` directly loads that API implementation and its SDK immediately.

For single-file Node ESM bundles, some SDK dependencies may still use dynamic CommonJS `require()` internally. If you see errors such as `Dynamic require of "child_process" is not supported`, add a Node `require` shim to the bundle. With esbuild:

```bash
esbuild app.js --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "module";const require = createRequire(import.meta.url);' \
  --outfile=app.bundle.js
```

This is only for Node bundles; it is not a browser or Cloudflare Workers workaround.

### Provider-scoped environment overrides

Use request `env` for account IDs, project/location, cache retention, and proxies. See [Request overrides](models.md#request-overrides) for precedence.

## Native provider maintenance

Use the repository [provider workflow](../../../.candy/skills/add-llm-provider.md) for native factories, catalog generation, and tests. API implementations are under [src/api](../src/api); provider contracts are in [models.ts](../src/models.ts).
