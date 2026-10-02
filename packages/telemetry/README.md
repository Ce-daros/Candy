# @candy/telemetry

Explicit callback-managed telemetry contexts, typed schemas, an inert context, and an in-memory reference adapter. The package has no exporter or global current-span state. Hosts can adapt it to their diagnostics backend.

```bash
npm install @candy/telemetry
```

## Record an operation

```typescript
import { InMemoryTelemetryContext } from "@candy/telemetry";

const telemetry = new InMemoryTelemetryContext();
const result = await telemetry.startSpan({ name: "files.read" }, async (span) => {
  span.addEvent("files.opened");
  span.setAttributes({ bytes: 12 });
  return 12;
});
console.log(result, telemetry.getSpans());
```

A span is a diagnostic record for one operation. Pass the callback's span as the parent context to nested work. Attributes describe state; events describe occurrences; status records `ok` or `error`. `startSpan()` owns completion until the callback settles, so there is no public `end()` method. Set status explicitly for failures represented by ordinary return values.

## Adapter contract

An adapter implements `TelemetryContext` and `TelemetrySpan` from [index.ts](src/index.ts):

- Invoke the callback synchronously and exactly once, preserving its result and rejection identity. Convert a synchronous throw to a rejected promise with the same value.
- Keep the native span open until the returned value or promise settles. Normal completion is `ok`; throws and rejections are errors unless status was set explicitly.
- Repeated status writes use the last value. Attribute writes merge; later defined values replace earlier values and `undefined` is ignored.
- Recording methods are synchronous, passive, and non-throwing. Ignore calls after settlement. A failed recording call is ignored atomically and never prevents business execution.

Backend activation, exporting, flushing, sampling, IDs, and buffering belong to the adapter. Candy passes contexts explicitly; it does not require ambient runtime state.

`NOOP_TELEMETRY_CONTEXT` observes the same callback contract using a shared frozen inert span and retains no data. `InMemoryTelemetryContext.getSpans()` returns detached snapshots in start order with deterministic IDs, parents, attributes, events, status, and end sequence, but no timestamps. Storage is unbounded and process-local; use a fresh context per recording scope or test.

## Typed schemas

```typescript
import { createTypedSpanStarter, defineTelemetrySchema, InMemoryTelemetryContext } from "@candy/telemetry";

const schema = defineTelemetrySchema({
  version: 1,
  spans: {
    "files.read": {
      description: "Read a file",
      parents: { kind: "any" },
      startAttributes: {
        path: { type: "string", required: true, description: "File path", sensitive: true },
      },
      endAttributes: {
        bytes: { type: "number", description: "Bytes read" },
      },
      status: { default: "ok", errorWhen: "The operation throws" },
    },
  },
} as const);
const telemetry = new InMemoryTelemetryContext();
const startSpan = createTypedSpanStarter(telemetry, [schema]);
await startSpan("files.read", { path: "notes.txt" }, (span) => {
  span.setAttributes({ bytes: 12 });
});
```

Schemas are serializable metadata; `defineTelemetrySchema()` is a typed identity function, not runtime validation. Parent declarations document any parent, a root/external parent, or named spans. They are not enforced by adapters.

`startAttributes` and event attributes declare requiredness. `endAttributes` are always optional enrichment, can be set while the callback is active, and do not end the span. At compile time, the typed starter rejects unknown keys, missing required values, invalid closed-set values, and undeclared events. Narrow union names before calling an overload. Its callback receives a child starter bound to the current span.

Attribute types are primitive strings, numbers, booleans, and arrays of those values. `values` and `elementValues` define closed sets; metadata includes descriptions, examples, sensitivity, and cardinality. Compose schemas with a tuple; separately declared arrays need `as const`. Duplicate literal span names are rejected at compile time. Schema values are not retained or inspected at runtime.

## Conformance and integration

`createTelemetryAdapterConformance()` from `@candy/telemetry/testing` returns grouped runnable cases. Supply a fresh context and a `getSpans()` reader that normalizes finished backend spans to `RecordedTelemetrySpan`. The suite checks admission, settlement, statuses, attributes, ordering, nesting, concurrency, and suppression of recording failures. See [testing exports](src/testing/index.ts) for fixture types and runner integration. This subpath uses Node assertions; the root is runtime-neutral.

Import telemetry contracts directly from this package. `@candy/ai` accepts `telemetryContext` in request options; agent-core does not re-export these types. Domain schemas belong to applications.

Telemetry is diagnostic data rather than durable state. Do not store context/span objects in messages, snapshots, or deferred handles. Avoid recording prompts, output, credentials, headers, or free-form payloads unless the caller's data policy permits them. Backend adapters own runtime compatibility.

## License

MIT
