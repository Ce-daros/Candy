# Streaming and tools

`Models.stream()` and `complete()` accept API-specific options; `streamSimple()` and `completeSimple()` map a common option set. Streaming returns an `AssistantMessageEventStream`; await `result()` for the final assistant message. Completed calls include usage and cost.

## Events

Successful generation follows `start → updates → done`. Failure after generation starts ends in `error`; setup failure may emit only `error`. There is one terminal event, and updates or `done` before `start` are invalid.

| Event | Fields and meaning |
|---|---|
| `start` | Live partial assistant message |
| `text_start`, `thinking_start`, `toolcall_start` | Begin a block at `contentIndex` |
| `text_delta`, `thinking_delta` | Append `delta` to that block |
| `toolcall_delta` | Incremental JSON arguments; partial parsing is best-effort |
| `text_end`, `thinking_end` | Authoritative completed `content` |
| `toolcall_end` | Complete `toolCall`, still requiring schema validation |
| `done` | Final `message` and successful `reason` |
| `error` | Final error/aborted assistant message in `error` |

Events for different blocks can interleave. Track each by `contentIndex`. `partial` is a shared live helper, not an event-time snapshot: queued events may reference content that has already advanced. Ordinary text/thinking starts empty; redacted thinking may be complete at start with no deltas. Do not retain partial objects as historical snapshots.

Partial tool arguments can be incomplete strings, arrays, or objects; their minimum value is `{}`. Execute only after completion and validation. Google supplies complete function arguments in a single tool-call delta.

`AssistantMessageFrameEncoder` converts events to compact persistable frames without cloning growing messages. Create one per stream and feed every event in order. It checkpoints already-advanced blocks once, then suppresses covered queued deltas. Terminal events produce no frame. `reduceAssistantMessageFrames()` reconstructs interleaved blocks in one pass, uses authoritative end values, rejects malformed sequences, and returns `undefined` without a start frame. Tool schema validation remains separate.

## Tool calls

Tools use TypeBox parameter schemas:

```typescript
import { Type, type Tool } from "@candy/ai";

const echo: Tool = {
  name: "echo",
  description: "Return the supplied text",
  parameters: Type.Object({ text: Type.String() }),
};
```

The AI package generates calls but does not execute them. A host validates a completed call with `validateToolCall()`, runs the operation, and appends a tool-result message with the call ID, tool name, content, error flag, and timestamp before requesting continuation. Results can include images and nested usage. Use [agent-core](../../agent/README.md) for scheduling and tool execution.

### Constrained sampling

`constrainedSampling: false` is equivalent to omission. JSON-schema `strict: "prefer"` requests provider enforcement when supported; `strict: "require"` rejects unsupported models. OpenAI, Anthropic, Mistral, and Gemini 3 support strict tools through their adapters. Earlier Gemini models cannot enforce required parameters. Capability metadata and custom `compat.supportsStrictMode` control eligibility.

OpenAI also supports Lark and regex grammar tools when model metadata enables `compat.supportsOpenAIGrammarTools`. Lark wins when both variants are supplied. Native grammar tools require an object schema with exactly one required string property and a non-empty supported grammar. Endpoints that do not pass custom tools through must leave the capability disabled; otherwise ordinary JSON-schema handling applies. Inspect [ConstrainedSamplingConfig](../src/types.ts) for the exact declaration.

## Thinking and stop reasons

Use `getSupportedThinkingLevels(model)` to discover levels. Simple options map thinking budgets and levels across providers; full options use the narrowed API's native controls. `xhigh` and `max` require model opt-in. Non-reasoning models ignore reasoning options.

| Stop reason | Meaning |
|---|---|
| `pending` | Transient streaming message |
| `stop` | Response completed |
| `length` | Output limit reached |
| `toolUse` | Tool results required |
| `deferred` | Provider returned a retrievable deferred handle |
| `error` | Request failed |
| `aborted` | Request cancelled |

Provider-specific `responseId`, replay signatures, and diagnostics are opaque metadata. Preserve them when retaining conversation messages. Usage reasoning is already included in output tokens; do not add it twice.

## Failures, cancellation, and inspection

After a stream is returned, request failures are encoded as an error event and final message rather than rejecting `result()`. Collection authentication failures follow the same path. Direct API `streamSimple()` can throw synchronously when required auth is missing.

Pass `signal` to cancel. The final message keeps partial content and has `stopReason: "aborted"`; a host may retain it and continue later. `onPayload` inspects outbound requests. `onProviderStreamEvent` sees parsed provider events before normalization, not necessarily original bytes; treat them as read-only. Callbacks are awaited in order, slow callbacks delay consumption, and thrown errors fail the request. SDK-backed adapters expose only fields their SDK retains.

## Transcript and system replay

`Context.systemPrompt` and `tools` are shorthand for an initial system message. Collection entry points normalize once; providers and API implementations receive `TranscriptContext` containing only `messages`.

```typescript
import { getCurrentSystemMessage, type Context } from "@candy/ai";

const context: Context = {
  messages: [
    { role: "system", content: "Answer briefly.", timestamp: Date.now() },
    { role: "user", content: "Explain the change.", timestamp: Date.now() },
  ],
};
const currentSystem = getCurrentSystemMessage(context.messages);
```

Later system messages append text, patch named sections, or add/remove tools. `replace: true` establishes a new baseline. Sections render verbatim after content, separated by blank lines. Read the current prompt and tools through transcript replay helpers rather than `context.systemPrompt` in an API implementation.

Verified models with `supportsMidConvoSystemMessages` receive later system messages in place. Other models collapse them to a replayed leading checkpoint. Anthropic `supportsMidConvoToolChanges` uses native tool addition/removal with a stable deferred placeholder; it requires an initial tool and no same-name redefinition. Otherwise tools are sent as the current top-level list. OpenAI Responses models with additional-tools or tool-search support can anchor additive tool changes to their message. These transitions affect prompt-cache reuse.

Cross-provider normalization preserves user/tool results and ordinary assistant text/tool calls, while converting foreign thinking to tagged text. Provider replay data is handled by the corresponding adapter. Context and models are plain JSON data; serialized images retain their base64 payloads.

## Faux provider

`fauxProvider()` from `@candy/ai/providers/faux` consumes scripted responses in request-start order. Set or append replies with its handle. Empty queues produce an assistant error. Use `fauxAssistantMessage`, `fauxText`, `fauxThinking`, and `fauxToolCall` to construct responses.

Usage is estimated at one token per four characters; session IDs and enabled retention simulate prompt caching. Tool arguments stream incrementally. Delivery uses microtasks unless `tokensPerSecond` sets pacing. Create separate provider IDs for independent concurrent flows. The [README example](../README.md#start) shows the minimal setup.
