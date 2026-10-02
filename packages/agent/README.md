# @candy/agent-core

The model loop and tool scheduler used by Candy. The host owns committed history; `AgentInputs` owns steering and follow-up queues. `Agent` owns model selection, executable tools, and transient run state.

```bash
npm install @candy/agent-core
```

## Start a loop

This in-memory example uses a faux provider and needs no credentials or network:

```typescript
import { createModels } from "@candy/ai";
import { fauxAssistantMessage, fauxProvider } from "@candy/ai/providers/faux";
import { Agent, AgentInputs, type AgentLoopHost, type AgentMessage } from "@candy/agent-core";

const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage("Hello.")]);
const models = createModels();
models.setProvider(faux.provider);
const messages: AgentMessage[] = [
  { role: "system", content: "Answer briefly.", timestamp: Date.now() },
];
const host: AgentLoopHost = {
  messages: () => messages.slice(),
  commit: (message) => {
    messages.push(message);
    return { message, entryId: undefined };
  },
  reset: () => { messages.splice(1); },
};
const inputs = new AgentInputs();
const agent = new Agent({
  host,
  inputs,
  initialState: { model: faux.getModel() },
  streamFn: models.streamSimple.bind(models),
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
await agent.prompt("Hello");
```

Replace the provider collection and selected model to use a hosted service. Provider authentication and stream options are described in [@candy/ai](../ai/README.md). For Candy's persistence, resources, compaction, and session replacement, use the [coding-agent SDK](../coding-agent/docs/sdk.md).

## Host and state

`host` and `inputs` are required constructor dependencies. `initialState` accepts only model, thinking level, and executable tools. Declare the system prompt in history through a system message. `agent.state.messages` projects host history; change committed records through the host rather than assigning that property.

| Host operation | Contract |
|---|---|
| `messages()` | Return the current projected conversation |
| `commit(message)` | Commit a finalized message and return its message and optional entry ID before listeners see it |
| `reset()` | Reset history to the host's chosen prompt/tool baseline |
| `prepareRequest` | Prepare canonical context immediately before each provider request |
| `prepareNextTurn` | Prepare context or state before the next turn |
| `finishTurn` | Finalize committed assistant and tool results before `turn_end` |

Supply hooks on the host at construction. `finishTurn` may return `undefined` for normal scheduling, `{ action: "end" }` to end after `turn_end`, or `{ action: "continue" }` to ensure one next request. Existing tool or queue scheduling can satisfy continuation; error and aborted responses remain hard exits. Unconditional continuation loops indefinitely.

`convertToLlm` maps custom `AgentMessage` roles to provider messages, after the optional `transformContext`. Preserve system messages and tool declarations. Exact option and event types live in [agent.ts](src/agent.ts) and [types.ts](src/types.ts).

## Inputs and completion

`prompt()` accepts text with optional images, one message, or a message batch. It rejects concurrent prompts and requires a selected model. `continue()` rejects empty or system-only history. A non-assistant tail continues existing context; an assistant tail requires queued steering or follow-up input.

Queue user messages through `inputs.steer()` or `inputs.followUp()`. Steering is delivered after the current turn's tools finish; follow-up is delivered when tool and steering work would otherwise stop. Each queue supports `all` and `one-at-a-time` delivery. Use `getQueuedInputs()` to inspect pending input and `withdrawQueuedInputs()` to restore text and images to a host editor.

Final messages are committed before `message_end`. A turn contains one assistant response and its tool results. `Agent.subscribe()` listeners are awaited in registration order. `agent_end` closes the low-level loop; `prompt()` and `waitForIdle()` settle after its awaited listeners finish. `abort()` signals cancellation. Candy adds its own recovery and `agent_settled` lifecycle above this package.

## Tools

An `AgentTool` supplies a name, label, description, TypeBox schema, and `execute()` returning content and details. Throw to produce an error result; return `details: undefined` when there are no structured details. Optional usage reports nested model work.

Parallel execution is the default. Preflight runs sequentially, allowed tools execute concurrently, completion events follow completion order, and committed tool results retain assistant source order. A tool with `executionMode: "sequential"` makes its whole batch sequential.

`beforeToolCall` sees validated arguments and may block execution. `afterToolCall` can replace content, details, usage, error state, or the termination hint field by field. Omitted fields retain their values. `terminate: true` skips automatic follow-up only when every finalized result in the batch requests it.

For direct loop control, use `agentLoop()` or `agentLoopContinue()` from [agent-loop.ts](src/agent-loop.ts). Their event streams are observational and do not await consumer processing; use `Agent` when message handling must form a barrier before tool execution. [proxy.ts](src/proxy.ts) supplies backend-proxied streaming for browser hosts.

## License

MIT
