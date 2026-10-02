# Choose a Model

For a built-in provider, open Actions → Sources to connect it, then choose a model in the Model selector. Use custom model configuration when candy does not already include the provider or endpoint you need.

## Choose a connection

| What you have | Recommended setup |
|---|---|
| A supported subscription | Sign in through Sources |
| A provider API key | Store it through Sources or set its environment variable |
| A local GGUF model | Configure its server as a compatible endpoint in `models.json` |
| An OpenAI-, Anthropic-, or Google-compatible endpoint | Add it to `models.json` |
| A provider with a custom protocol or authentication flow | Build or install a provider extension |

candy starts with its bundled model catalog covering providers, model IDs, capabilities, context limits, and pricing. Cached catalog data remains available offline; run `candy update --models` to force a refresh of configured providers.

## Authenticate

Press Escape twice in an empty editor, then choose Sources and select a provider to connect it. candy stores credentials in [`auth.json`](configuration.md#agent-directory). Remove saved credentials from that provider's page.

You can instead provide an API key through the provider's environment variable. This is useful in CI and other environments where candy should not write credentials. [Provider Authentication](providers.md) lists the variables and cloud-provider setup.

When several credential sources are configured, candy uses a runtime `--api-key` first, then a stored `auth.json` credential, an `apiKey` from `models.json`, and finally the provider's environment variables or ambient cloud credentials. Provider extensions can define their own authentication behavior.

Keep `auth.json` and any credential commands private. Project settings and extensions can execute inside the candy process after you trust a project. Review [Security](security.md) before loading configuration from an untrusted directory.

## Select a model

Press `Ctrl+L` or click Model in the editor border to open the Powerbar. `Left` and `Right` browse the quick-selection scope; typing searches model names, IDs, and providers. `Enter` changes the model for the current session. `Up`, `Down`, and `Tab` do nothing in model selection. Press Escape twice in an empty editor and choose Sources to manage provider access, refresh catalogs, and choose which models appear here. Sources keeps configured scope entries when a model or its authentication becomes unavailable. An unset scope includes every available model; an explicitly empty scope shows no quick-selection models.

In Sources, `Space` toggles the highlighted model in quick selection. Select or clear a provider as a group. `Ctrl+A` includes the models matching the current search, `Ctrl+D` clears those matches, and `Tab` moves between search and the list. Bulk actions do nothing when the search has no matches. Clicking a row focuses it. Scope edits take effect when you return from Sources to Actions: the current model stays if still available in scope; otherwise Candy selects the first available scoped model, or clears the active model when none remain. Starting or restoring a session preserves its model.

Choose Actions → Current Model to inspect the active model. Its details show the model's full ID, provider, input types, context and output limits, reasoning support, and price. **Set as default** saves the model for new sessions without changing the current session. You can also set or clear the model's default thinking level and compaction token overrides there. Details shows the source of an inherited thinking or compaction value.
Numeric override inputs open with their current saved value filled in.

Press `Shift+Tab` to cycle the active model's thinking effort from the editor or during model selection. The effort label and meter show the current level. Models without reasoning show Off and report that thinking is unsupported when the shortcut is pressed. Configure a model's saved Default thinking through Actions → Current Model; the global default thinking level is available in Command.

A session records model and thinking-level changes. Resuming the session restores them without changing defaults for new sessions.

## Configure a compatible endpoint

Use [`models.json`](configuration.md#agent-directory) when an endpoint speaks an API candy already supports. This includes most Ollama, LM Studio, vLLM, SGLang, and proxy deployments.

A custom backend that implements Candy's `pi-messages` protocol can set `api` to `"pi-messages"` in its provider entry.

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

The dummy key makes the model available to candy; Ollama ignores it. For an authenticated endpoint, `apiKey` and header values can use `$NAME` or `${NAME}` environment interpolation, a literal value, or a leading `!command`. Commands in `models.json` run at request time and are not cached by candy.

Press Ctrl+R after changing `models.json`. A `models` entry adds or replaces a model with the same ID on that provider. Use `modelOverrides` to change metadata for an existing built-in or extension-provided model without replacing the provider's model list. Unknown override IDs are ignored.

### Describe model input and caching

Use `inputLimits.images.resize` to control how candy encodes new image attachments, `read` results, and tool-result images before storing them in conversation history:

```json
{
  "id": "vision-model",
  "input": ["text", "image"],
  "inputLimits": {
    "images": {
      "resize": {
        "maxWidth": 1568,
        "maxHeight": 1568,
        "maxBytes": 524288,
        "jpegQuality": 75
      }
    }
  }
}
```

`maxBytes` limits the base64-encoded payload. Omitted resize fields use conservative defaults of 2000 by 2000 pixels, 4.5 MiB encoded, and JPEG quality 80. Images are encoded once; changing models does not rewrite historical images. The catalog can also describe hard request limits with `inputLimits.maxRequestBytes`, `images.maxPerMessage`, and `images.maxPerRequest`, but candy does not yet rewrite or reject history based on them.

<a id="prompt-cache-lifetimes"></a>

Use `promptCache` to declare the provider's best-effort cache lifetime in seconds for the `short` or `long` retention tier:

```json
{ "id": "claude-sonnet-5", "promptCache": { "short": 300, "long": 3600 } }
```

Choose the conservative end of any published range. A model without a lifetime for the active tier is not eligible for cache warming. A `modelOverrides` entry can set `inputLimits` or `promptCache` for a built-in or extension model, including a model accessed through a validated proxy. See [`cacheWarming`](settings.md#model-and-thinking).

Compatibility settings should describe verified differences in the endpoint's request or response behavior. Do not enable them based only on an endpoint advertising OpenAI or Anthropic compatibility.

## Add a custom provider

Use an extension when the provider needs custom streaming, model discovery, or authentication behavior. See [Custom Providers](custom-provider.md) for the extension workflow.

## Troubleshooting

### A model does not appear

Check the provider status in Sources. Custom models can load from `models.json` but remain unavailable in quick selection until candy can resolve credentials.

### Authentication works in one shell only

Check whether the key came from an environment variable rather than `auth.json`. Environment variables must be present in the process that starts candy.

### Sign-in opens a browser on a remote machine

Complete the provider's headless authentication flow when available. Some providers let you paste the final redirect URL or authorization code back into candy. See [Authenticate interactively](providers.md#authenticate-interactively).

### A compatible endpoint rejects requests

Check its API type and compatibility settings in `models.json`. The upstream server must support the corresponding request fields and behavior.
