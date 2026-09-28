# Examples

Example code for the coding-agent SDK and process integration.

## CLI integration

[`rpc-client.ts`](rpc-client.ts) uses the typed `RpcClient` to run candy in a child process, stream events, and wait for the run to settle.

Build the coding-agent package before running it from a repository checkout:

```bash
node examples/rpc-client.ts "Explain this repository"
```

## Directories

### [sdk/](sdk/)
Programmatic usage via `createAgentSession()`. Shows how to customize models, prompts, tools, extensions, and session management.

## Documentation

- [SDK Examples](sdk/README.md)
- [CLI Integration](../docs/cli-integration.md)
- [Extensions Documentation](../docs/extensions.md)
- [Skills Documentation](../docs/skills.md)
