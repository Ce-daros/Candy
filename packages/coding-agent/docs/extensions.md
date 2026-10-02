# Extensions

Extensions are TypeScript modules that add executable behavior to candy. Use one when a workflow needs tools, commands, event handlers, model providers, session state, or terminal UI rather than instructions alone.

An extension runs inside the candy process with the same operating-system permissions. It can inspect prompts, tool calls, files, credentials, and session history, so load extensions only from sources you trust.

Typical extensions add an agent tool, protect paths, confirm dangerous commands, react to session events, modify context, expose a command, or display persistent status.

<a id="quick-start"></a>
<a id="writing-an-extension"></a>
<a id="create-an-extension"></a>

## Create and load an extension

An extension exports a default factory that receives `ExtensionAPI`. The factory registers capabilities for the current extension runtime.

Create `~/.candy/agent/extensions/hello.ts`:

```typescript
import type { ExtensionAPI } from "@candy/coding-agent";

export default function (candy: ExtensionAPI) {
  candy.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (name, ctx) => {
      ctx.ui.notify(`Hello, ${name || "world"}!`, "info");
    },
  });
}
```

Start candy, open Command, and choose `hello`. During development, load a file directly:

```bash
candy --extension ./hello.ts
```

candy uses `jiti`, so local TypeScript extensions do not need a separate compilation step. Use [candy packages](packages.md) for distributed extensions and dependencies.

Import extension contracts such as `ExtensionAPI` from `@candy/coding-agent`. The extension UI is host-rendered through dialogs and text updates; extensions do not install terminal components or renderers.

<a id="extension-locations"></a>
<a id="available-imports"></a>
<a id="choose-where-it-loads"></a>

## Add it to candy

Place the extension in your user or project extensions directory. candy loads direct TypeScript or JavaScript files and subdirectories containing an `index.ts` or `index.js` entry point.

Use a single file for a small extension and a directory for a multi-file implementation. Put npm dependencies in a nearby `package.json`. See [Configuration](configuration.md) for conventional locations and [Settings](settings.md#resources) for additional paths.

Reload replaces the extension runtime, so code after `await ctx.reload()` must not reuse state from the old runtime. Only personal and explicit command-line extensions can participate in the `project_trust` event that runs before project extensions load.

<a id="understand-the-lifecycle"></a>

## Respect the runtime lifecycle

The factory can be synchronous or asynchronous. candy waits for an asynchronous factory before startup continues, allowing it to fetch configuration or register providers needed during startup.

Do not start processes, sockets, watchers, or timers in the factory because some invocations load extensions without starting a session.
Start long-lived resources from `session_start` or from the command or tool that needs them.
Close session-scoped resources from an idempotent `session_shutdown` handler.

A run proceeds from input and `before_agent_start` through model and tool work. `turn_end` runs after an assistant response and its tool results have been committed. `agent_settled` is notification-only and fires when Candy has no remaining automatic work.
<a id="agent_start--agent_end--agent_settled"></a>

<a id="extensionapi-methods"></a>

## Choose an integration point

| Capability | Main API |
|---|---|
| Observe or modify lifecycle behavior | `candy.on()` |
| Add a model-callable operation | `candy.registerTool()` |
| Add a Command entry | `candy.registerCommand()` |
| Add a shortcut or CLI flag | `candy.registerShortcut()` or `candy.registerFlag()` |
| Send user or custom messages | `candy.sendUserMessage()` or `candy.sendMessage()` |
| Persist non-context session data | `candy.appendEntry()` |
| Change active tools, model, or thinking level | Session control methods on `candy` |
| Add a model provider | `candy.registerProvider()` |
| Ask the user or show text | `ctx.ui` |
| Communicate with another extension | `candy.events` |

Use the exported declarations in [`extensions/types.ts`](../src/core/extensions/types.ts) for exact event, context, tool, and result types.

`ctx.resources` exposes the active session's shared resource operations. Use it to inspect discovered resources, read or save discovered instruction files, inspect or update scoped resource configuration, change active or default tools, and reload resources. Instruction saves report a reload failure separately from a successful file write. Resource changes follow the same idle checks and settings commits used by other Candy entry points.

## Follow the extension contracts

<a id="events"></a>
<a id="work-with-events"></a>

### Events and concurrency

Handlers run in extension load and registration order. `candy.on()` returns a function that unsubscribes that registration; changes do not affect a dispatch already in progress.
Some events notify; others transform input or tool results, or cancel an operation.
Use each event’s declared result type rather than assuming every return value has an effect.

Events cover resource discovery, session lifecycle, request preparation, completed turns, tools, and input.

`before_agent_start` exposes both the current prompt and its structured `systemPromptOptions`. Prefer changing prompt sections, selected tools, or guidelines so candy can append a transcript delta. Returning `systemPrompt`, or setting `forceSystemPrompt`, replaces the whole prompt for that run while the transcript continues recording the structured sections. Providers receive the forced text as their leading system prompt.

`context` transforms conversation messages; Candy restores the system prompt and tool declarations afterward. `tool_call` can mutate input or block execution. `tool_result` handlers compose, with each handler seeing prior changes.

`turn_end` is the only boundary where handlers can append `custom`, `custom_message`, or `context_edit` entries and request another model response. Handlers run in registration order, and each sees changes from earlier handlers. Return `continue: true` only when the appended context gives the model useful work; an unconditional continuation can loop. Compaction records and retry decisions belong to Candy.

Tool calls from one assistant message can run in parallel.
Do not assume a sibling call or result exists when another tool event runs.
Use `ctx.signal` for nested work owned by an active turn; commands and idle session events often have no operation signal.

A `user_bash` handler that returns `undefined` passes the command to the next handler and then to local execution if no handler handles it. Returning `operations` or `result` stops propagation. A handler failure blocks the command rather than falling through to local execution.

<a id="custom-tools"></a>
<a id="register-tools"></a>

### Tools

A custom tool defines a name, model-facing description, TypeBox parameter schema, and `execute()` function.
Its result requires model-facing `content` and a `details` field for state reconstruction.
Use `details: undefined` when there are no structured details. If the tool makes nested model calls, include their `usage` in the result so session totals remain accurate.

Throw from `execute()` to produce a failed tool result.
Returning an object does not mark it as an error.
Return `terminate: true` only when the agent should skip its automatic follow-up after every completed tool in that batch agrees to terminate.

Use sequential execution when tools share mutable in-memory state.
File-mutating tools should wrap the complete read-modify-write operation with `withFileMutationQueue()`.
Truncate large model-facing results and tell the model where to read the complete output.


### Activate tools dynamically

Register every tool first, keep optional tools inactive, and use `candy.setActiveTools()` from a loader tool to select the desired active tools. Names must already be registered; unknown names are ignored.

candy records the initial prompt and tool set in the transcript's first system message, then appends tool and prompt changes before the next model request. Providers that cannot represent the transition receive a complete transcript checkpoint, which can invalidate the cached prefix.

<a id="extensioncontext"></a>
<a id="extensioncommandcontext"></a>
<a id="use-extension-context"></a>

### Context and session changes

`ExtensionContext` provides the working directory, mode, UI, read-only session history, model runtime, abort signal, context usage, and controls for compaction and shutdown.
Use `ctx.modelRuntime.streamSimple()` for provider-neutral nested model calls.

Command handlers receive `ExtensionCommandContext`, which adds operations for waiting until idle, reloading, tree navigation, and session replacement.
These operations are command-only because calling them from lifecycle handlers can deadlock the runtime.

Session replacement invalidates the old context. Capture only plain data before switching, then use the fresh context supplied to `withSession` for session-bound work. Command handlers can call `ctx.clone({ withSession })` to duplicate the current branch through the same replacement lifecycle.

<a id="state-management"></a>
<a id="persist-state"></a>

### State

Choose storage based on how state participates in the conversation:

| State | Storage |
|---|---|
| Tool state that follows the active branch | Tool-result `details` |
| Durable data excluded from model context | `candy.appendEntry()` |
| Custom content stored and sent to the model | `candy.sendMessage()` |
| Data outside one session | External storage |

Reconstruct branch-sensitive state from `ctx.history.getBranch()` during `session_start`.
Do not rebuild it from every file entry because abandoned branches represent alternative histories.
Use a custom message when content should appear in the transcript; use `ctx.ui.setWidget()` for concise live status.

<a id="custom-ui"></a>
<a id="mode-behavior"></a>
<a id="interact-with-the-user"></a>
<a id="account-for-each-mode"></a>

### UI and modes

`ctx.ui` provides select, confirm, input, and multi-line editor dialogs, notifications, status text, and plain-text widgets. Hosts own the rendering and focus behavior. `ctx.mode` reports the current host, and `ctx.hasUI` indicates whether dialogs are available.

In interactive mode, dialogs follow the shared composer layout.

Extensions load in interactive, RPC, JSON, and print modes. RPC can forward supported dialogs and text updates through the [RPC Extension UI protocol](rpc-extension-ui.md); JSON and print modes have no UI.
Guard terminal-only behavior with `ctx.mode === "tui"` and use `ctx.hasUI` for interactions supported by interactive and RPC clients.

Keep tool and event behavior independent from rendering so non-interactive modes remain functional.

<a id="error-handling"></a>
<a id="handle-errors-and-shutdown"></a>

### Errors and cleanup

candy reports handler errors and continues where possible. A `tool_call` handler failure blocks the tool as a fail-safe; a tool execution failure becomes an error result for the model.

Release resources in `session_shutdown` even when normal operation attempted cleanup.
Keep cleanup idempotent because cancellation, reload, session replacement, and process exit can converge on the same path.
Use `ctx.shutdown()` to request an orderly process shutdown.

<a id="examples-reference"></a>
<a id="implementation-reference"></a>

## Implementation reference

The exported declarations in [`extensions/types.ts`](../src/core/extensions/types.ts) are the implementation reference for every event, context, tool, and result type described here.

Use [Custom Providers](custom-provider.md) for model-service integrations, [Terminal UI](tui.md) for Candy-owned interface components, and [candy Packages](packages.md) to install or distribute extensions with other resources.
