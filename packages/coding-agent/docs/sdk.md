# SDK

`@candy/coding-agent` embeds Candy in a Node.js or Bun process. Its root entry exports the headless session runtime, model and settings operations, session storage, tools, resource contracts, and extension authoring types. Import terminal components from `@candy/coding-agent/ui` and RPC client/protocol types from `@candy/coding-agent/rpc`. The executable RPC launcher remains `@candy/coding-agent/rpc-entry`.

Use the SDK for in-process TypeScript integration. For other languages or process isolation, use [RPC](rpc.md) or the [CLI integration](cli-integration.md).

## Create and dispose a runtime

`createAgentSessionRuntime()` is the SDK construction entry. The runtime owns the current session and session replacement lifecycle:

```typescript
import { createAgentSessionRuntime } from "@candy/coding-agent";

const runtime = await createAgentSessionRuntime();

try {
	const session = runtime.session;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	try {
		await session.prompt("What files are in the current directory?");
	} finally {
		unsubscribe();
	}
} finally {
	await runtime.dispose();
}
```

This uses the current working directory, standard resource discovery, stored settings, and configured credentials. `prompt()` resolves after the run and any automatic recovery finish. The runtime disposal promise settles active work and releases session resources.

The [minimal example](../examples/sdk/01-minimal.ts) also reads messages after a run. All [SDK examples](../examples/sdk/) are included in the repository TypeScript project.

## Session lifecycle

`runtime.session` is a read-only operations facade for the active conversation. Its `messages`, model, and prompt-template values are detached snapshots; read them again after an operation when you need current state. The facade exposes prompting, queueing, model and tool selection, context operations, subscriptions, and session metadata without exposing the underlying Agent or mutable message storage.

The runtime owns session replacement:

```typescript
await runtime.newSession();
await runtime.switchSession(sessionFile);
await runtime.fork(entryId);
await runtime.clone();
await runtime.importFromJsonl(jsonlPath);
```

After replacement, read `runtime.session` again and bind session-specific listeners to the new facade. The runtime also provides `cwd`, `settings`, `models`, `resources`, and startup diagnostics for the active session.

`runtime.newSession({ parentSession, withSession })` can record session lineage and run host setup against the replacement session. The `withSession` callback receives a context for the new session after replacement; use it for work that must follow the swap rather than keeping a reference to the old facade.

Sessions persist to JSONL by default. Supply `SessionManager.inMemory(cwd)` when the host does not want a session file. `SessionManager.create()`, `continueRecent()`, `open()`, and `list()` support persistent session workflows; the [sessions example](../examples/sdk/11-sessions.ts) shows the available factories. Branching updates the active leaf without deleting abandoned branches. [Session File Format](session-format.md) describes the persisted representation.

`cwd` selects the workspace for project resource discovery, context files, session grouping, and built-in tool paths. Pass it explicitly when the target differs from `process.cwd()` and create an in-memory `SessionManager` for that same cwd.

Configure credentials and model storage through `modelRuntimeOptions` when the runtime should own model-runtime construction:

```typescript
const runtime = await createAgentSessionRuntime({
	modelRuntimeOptions: {
		authPath: "/srv/candy/auth.json",
		modelsPath: "/srv/candy/models.json",
	},
});
```

The runtime registers its providers before its managed model-catalog refresh. It disposes the model runtime it creates. A supplied `modelRuntime` remains caller-owned and can be shared by multiple runtimes; await its `dispose()` after those runtimes have closed.

## Prompting and events

`prompt()` sends text or attachments. To run an extension command, prompt template, or skill, call `executeCommand({ source, name, args })` with `source` set to `"extension"`, `"prompt"`, or `"skill"`. Text beginning with `/` or `skill:` remains ordinary prompt text.

A prompt sent during an active run must specify whether it should steer the current run or follow it. `steer()` and `followUp()` express those choices directly. They resolve to `"queued"` when input waits behind the active operation or `"handled"` when an extension consumes it. `abort()` stops the current operation and waits for it to settle; `waitForIdle()` waits without aborting.

Subscribe before prompting when the host needs streamed output. `message_end` carries the completed message and its committed `entryId`; `turn_end` carries `messageEntry` and `toolResultEntries` for the same journal records. `agent_end` marks one low-level run; retries, overflow recovery, and queued inputs can continue. Use `agent_settled` when the host needs to know that no work will continue automatically.

## Configure resources and tools

The runtime factory creates the model runtime, settings manager, session manager, default resource loader, and default tools when those dependencies are omitted. Use `resourceLoaderOptions` for discovery overrides such as extension paths, prompt templates, skills, and system-prompt content. The factory binds these options to each session's effective working directory:

```typescript
import { createAgentSessionRuntime, SessionManager } from "@candy/coding-agent";

const cwd = process.cwd();
const runtime = await createAgentSessionRuntime({
	cwd,
	sessionManager: SessionManager.inMemory(cwd),
	resourceLoaderOptions: {
		appendSystemPromptOverride: (current) => [...current, "Keep answers concise."],
		additionalExtensionPaths: ["./extensions/review.ts"],
	},
});

try {
	console.log(runtime.resources.getInventory());
} finally {
	await runtime.dispose();
}
```

Without a theme adapter, the default resource loader disables theme discovery. A host that needs resource themes can provide `themeAdapter` from `@candy/coding-agent/ui`. A custom `resourceLoaderFactory({ cwd, agentDir })` is available when the host owns resource loading; return a loader prepared for the supplied working directory.

Resource settings use the same runtime operations exposed to other hosts. `await runtime.resources.getConfiguration("global")` or `getConfiguration("project")` returns resolved global/project paths and a `ResourceConfiguration` operation object. Use its `toggleResource(item)` and `setWriteScope(scope)` methods to change enabled state and choose where overrides are saved. Use `runtime.resources.getInventory()` to read the active discovered resources and diagnostics.

The built-in extension module map is headless and supports the SDK's extension API. If loaded extension files import UI components from `@candy/coding-agent/ui`, pass `extensionModules` from `@candy/coding-agent/extension-host-modules` to the runtime. This keeps UI implementation imports out of the SDK root while giving the extension loader the modules it needs.

Use `modelRuntime`, `model`, and `thinkingLevel` to choose model access and the initial selection. Use `tools`, `noTools`, `excludeTools`, and `customTools` to control available tools. See [models](../examples/sdk/02-custom-model.ts), [tools](../examples/sdk/05-tools.ts), [extensions](../examples/sdk/06-extensions.ts), and [full control](../examples/sdk/12-full-control.ts).

## Settings

`runtime.settings` exposes the active `SettingsManager`. Read settings through its getters or `getSetting(field)`. Setters return promises: await them to know the change has passed validation, reached storage, and become effective. A write failure rejects and leaves the previous effective value in place.

```typescript
await runtime.settings.setDefaultThinkingLevel("low");
await runtime.settings.commitSetting("global", "markdown", {
	...runtime.settings.getSetting("markdown"),
	mermaid: "off",
});
```

`SettingsManager.inMemory(initialSettings)` is useful for tests and hosts that do not want a Candy settings file. `applyOverrides()` supplies process-local runtime overrides; it does not save defaults. Use a scope-aware commit when the host intends to change persisted global or project defaults.

## Public entrypoints and migration

The package exposes separate entrypoints for separate responsibilities:

| Import | Use |
|---|---|
| `@candy/coding-agent` | Headless runtime, settings, model, session, resource, and extension APIs |
| `@candy/coding-agent/ui` | Terminal components, themes, and UI adapters |
| `@candy/coding-agent/rpc` | Typed `RpcClient` and protocol types |
| `@candy/coding-agent/extension-host-modules` | Module map for dynamically loaded extensions |
| `@candy/coding-agent/rpc-entry` | RPC process launcher |

Migrate direct session construction to `createAgentSessionRuntime()`, use `runtime.session` for conversation operations, and await `runtime.dispose()` instead of disposing an individual session. Move UI imports to `./ui` and RPC imports to `./rpc`. Settings changes now return promises; await each persisted operation instead of calling `mutateAndPersist()` or using `flush()` as a substitute for awaiting the operation.

Extension `ProviderConfig.refreshModels(context)` returns the extension provider's refreshed model list; use `context.publish()` when the catalog should persist. The AI package's native `Provider.refreshModels(context)` publishes through its provider context and returns no catalog. The former OAuth `modifyModels` compatibility hook is removed. `ctx.ui.setTheme()` is asynchronous; await its result before reporting whether the theme change succeeded.

See [Extensions](extensions.md), [Choose a Model](models.md), [Provider Authentication](providers.md), [Settings](settings.md), [Sessions and Context](sessions.md), [RPC](rpc.md), and [CLI Integration](cli-integration.md) for the related APIs.
