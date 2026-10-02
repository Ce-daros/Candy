---
name: add-llm-provider
description: Add a native model provider or API implementation to packages/ai and wire it into Candy.
---

# Add a model provider

Read `packages/ai/src/models.ts` and a provider with matching authentication and protocol before editing. Providers own authentication and catalogs; API implementations own wire conversion and streaming. A new provider using an existing API does not need a new protocol implementation.

1. Add the provider ID to `KnownProvider` in `packages/ai/src/types.ts`. For a new API, add its ID to `KnownApi` and its option type to `ApiOptionsMap`.
2. For a new API, create `src/api/<api-id>.ts` and its lazy wrapper. Export `stream` and `streamSimple`, consume `TranscriptContext`, emit balanced stream events, and honor cancellation. Add necessary option-type exports and package subpaths.
3. Update `packages/ai/scripts/generate-models.ts` to map catalog data to chat or image model entries. IDs are unique per provider and operation. Regenerate the tracked model JSON and generated wrappers; never edit `models.generated.ts` by hand.
4. Add `src/providers/<id>.ts` using `createProvider()`, provider-owned auth, catalog data, and an existing or new lazy API implementation. Register the factory in `src/providers/all.ts`; update environment credential detection in `src/env-api-keys.ts` when needed.
5. Add offline tests for catalog, auth, streaming, tools, usage, cancellation, and failure boundaries. Follow AGENTS.md for focused test commands. Extend the applicable `test/e2e/` matrix, but run credential-backed tests only when explicitly authorized.
6. In coding-agent, update `src/core/model-resolver.ts`'s `defaultModelPerProvider` if a startup default is needed. Update provider help in `src/cli/args.ts` and authentication setup in `docs/providers.md`.
7. Update the relevant AI reference and package Unreleased entries. Run required checks and report which behavior was exercised.

Native extension registration uses the same provider contract; see `packages/coding-agent/docs/custom-provider.md`. Inspect current dependency types instead of copying an older provider registration API.
