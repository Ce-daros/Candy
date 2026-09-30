# Examples

Examples for the coding-agent runtime, extension system, and process integrations.

## SDK

[`sdk/`](sdk/) contains checked TypeScript examples using `createAgentSessionRuntime()`. Each runtime exposes the active session through `.session` and must be disposed with `await runtime.dispose()`.

## RPC client

[`rpc-client.ts`](rpc-client.ts) imports `RpcClient` from `@candy/coding-agent/rpc`, starts Candy as a child process, streams events, waits for the run to settle, and stops the child. Build the coding-agent package before running it from a repository checkout:

```bash
node examples/rpc-client.ts "Explain this repository"
```

See [SDK](../docs/sdk.md), [RPC](../docs/rpc.md), [CLI integration](../docs/cli-integration.md), and [Extensions](../docs/extensions.md) for the public interfaces.
