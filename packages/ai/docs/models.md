# Models and authentication

Create a collection with `createModels()` and register providers with `setProvider()`. Each provider owns its identity, catalog, authentication, refresh, and streaming. Providers sharing a protocol reuse an API implementation.

## Provider factories

```typescript
import { createModels } from "@candy/ai";
import { anthropicProvider } from "@candy/ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-6");
```

Each factory imports its own catalog and a lazy API wrapper. `builtinProviders()` and `builtinModels()` from `@candy/ai/providers/all` explicitly load every built-in factory and catalog. See [all.ts](../src/providers/all.ts) for the supported set and Candy's [provider authentication reference](../../coding-agent/docs/providers.md) for environment variables and cloud setup.

## Catalog reads

Catalog reads are synchronous and return the last restored or refreshed catalog. Availability reads are asynchronous because they resolve authentication:

| Read | Result |
|---|---|
| `getProviders()` | Registered provider IDs |
| `getModels(provider)` / `getModel(provider, id)` | Chat models |
| `getModelsOfType(type, provider)` / `getModelOfType(type, provider, id)` | Models for one operation |
| `getAllModels(provider)` | Chat and image models |
| `await getAvailable()` / `await getAvailableOfType(type)` / `await getAllAvailable()` | Models with resolvable access |
| `await getAvailability()` | Shared provider authentication status, models, and errors |

IDs are unique per provider and operation. A chat model may omit `type`; image models require `type: "image"`. Use `isModelType()` or `getModelType()` rather than directly comparing an optional type. Use `hasApi()` to narrow dynamically read chat models for API-specific options.

Static built-in accessors such as `getBuiltinModel()` from `@candy/ai/providers/all` preserve literal provider/model typing without a collection. See [the exported catalog accessors](../src/providers/all.ts). Models are serializable metadata; they carry no provider implementation.

## Refresh

`await models.refresh()` fetches configured dynamic providers. Options can restrict `providers`, force a refresh, restore storage with `allowNetwork: false`, or supply an abort `signal`. Without a signal, refresh has no caller deadline.

`ModelsStore` persists operation-specific catalogs. Its read, write, and delete operations accept cancellation. Providers always receive a concrete refresh signal and must honor it. A caller-supplied signal releases the collection's wait promptly even if a custom provider fails to stop its underlying work.

Handwritten providers receive `context.stored` and publish through `context.publish({ persist, update })`. Omitted `persist` keeps storage, a store entry writes it, and `null` deletes it. Put synchronous catalog mutations in `update`; generation checks prevent stale refreshes from publishing.

## Authentication

Providers resolve stored credentials, environment variables, or ambient credentials. `createModels()` accepts `credentials`, `modelsStore`, and `authContext`; default stores are in memory. Persistent hosts implement the [store contracts](../src/models.ts).

`getAuth(providerId)` resolves provider credentials; `getAuth(model)` also includes static model headers. Both may refresh OAuth and return `apiKey`, `headers`, or `baseUrl`. Unconfigured access resolves to `undefined`; broken resolution rejects with `ModelsError`. `checkAuth()` inspects readiness. Stream paths encode authentication failures as stream errors.

`CredentialStore` provides `read`, non-secret `list`, serialized `modify`, and `delete`. Enumeration never resolves secrets or runs key commands. Refresh happens inside `modify` so concurrent callers cannot rotate a token twice. A stored credential owns its provider: failed refresh does not fall through to an environment key.

```json
{
  "type": "api_key",
  "key": "provider-key",
  "env": { "CLOUDFLARE_ACCOUNT_ID": "account-id" }
}
```

Authentication operations accept caller cancellation and have no deadline when omitted. Provider login, key check/resolve, and OAuth refresh implementations receive a concrete signal for blocking work.

## Request overrides

Explicit stream `apiKey`, `headers`, and `baseUrl` override resolved authentication. Header names merge case-insensitively in this order:

```text
provider auth → model.headers → request headers → transformHeaders
```

`transformHeaders` runs once on the collection before dispatch and is removed from provider options. Returning `null` for a header suppresses lower-level defaults that support deletion. Use the transform instead of resolving auth separately before a request.

Request `env` values take precedence over process variables for provider configuration, including Cloudflare IDs, Vertex project/location, cache retention, and HTTP proxies. Scope these values when one host serves different accounts.

## OAuth and cloud access

OAuth-capable providers expose `provider.auth.oauth`: `login(interaction)`, `refresh(credential, signal)`, and `toAuth(credential)`. Login uses provider-neutral prompts and notifications. Store its result through `CredentialStore.modify()`; later auth resolution refreshes it under the same lock. OpenRouter login returns a permanent API key rather than an expiring bearer credential.

OAuth login flows are Node-only and lazy-loaded. Browser hosts need backend-managed OAuth. Vertex AI supports a Google Cloud API key or Application Default Credentials with project and location; use the [cloud setup reference](../../coding-agent/docs/providers.md#google-vertex-ai).

The `candy-ai login [provider]` CLI stores OAuth credentials in `auth.json` in its current directory. `candy-ai list` lists login providers. This store is separate from Candy's agent directory; an embedding host must supply its chosen persistent credential store.
