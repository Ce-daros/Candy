# candy evals

Host evals for candy's coding agent, built with `vitest-evals`.

## File conventions

Eval definitions are flat under `evals/`:

- `*.eval.ts` files are host evals. They run with Vitest on this machine and are ordinary vitest-evals suites.

Support code:

- `src/harness.ts` adapts `vitest-evals` to a real `AgentSession`, with an isolated workspace and home directory.

## Run evals

Host evals need `CANDY_PROVIDER` and `CANDY_MODEL`:

```bash
CANDY_PROVIDER=openai-codex CANDY_MODEL=gpt-5.6-sol npm run eval -w packages/evals
```

One suite:

```bash
CANDY_PROVIDER=openai-codex CANDY_MODEL=gpt-5.6-sol \
  npm run eval -w packages/evals -- evals/smoke.eval.ts
```

`npm run test -w packages/evals` runs the unit tests for the runner code.

## Write an eval

Use one ordinary `describeEval(...)` suite and one explicit `run(...)` call per case:

```ts
import { describeEval, StructuredOutputJudge } from "vitest-evals";
import { createCandyCodingAgentHarness } from "../src/harness.ts";

const harness = createCandyCodingAgentHarness();
const judge = StructuredOutputJudge({ expected: { ok: true }, match: "strict", allowExtras: false });

describeEval("Target workflow", { harness, judges: [judge], judgeThreshold: null }, (it) => {
  it("completes the task", async ({ run }) => {
    await run("Complete the target task.");
  });
});
```

Use `judgeThreshold: null` for comparative scoring. A low score is data, not an infrastructure failure. Reserve Vitest assertions for broken suite invariants.

Artifacts produced by a run may contain prompts, responses, generated code, and tool output.
