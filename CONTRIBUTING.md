# Developing Candy

Candy is a personal project for daily work in the terminal. It began as a fork of pi and is developed independently. Upstream changes are evaluated individually and cherry-picked when they serve the product.

Common daily workflows belong in Candy; specialized workflows and integrations can use extensions.

## Development documents

- [DESIGN.md](DESIGN.md) describes the product's design philosophy.
- [AGENTS.md](AGENTS.md) defines implementation, validation, workspace safety, dependency maintenance, and changelog rules.
- [Terminal guide](packages/coding-agent/docs/usage.md) describes how to use Candy.

Run coding agents from the repository root so they read AGENTS.md.

## Making changes

Start with a concrete task or reproducible problem. For a bug, record expected and actual behavior and the relevant platform or terminal details. Remove credentials and private conversations from shared logs.

Discuss changes to product boundaries, public APIs, dependencies, or persistence formats before a large implementation. Preserve user configuration and session data through any required migration.

Understand the code being changed and its effects. AI assistance does not replace responsibility for the resulting implementation, tests, and documentation.

Follow AGENTS.md for validation. Keep each change reviewable, update affected documentation and changelogs, and report the resulting behavior, verification, and remaining limitations. Commit only when requested.

## MCP acceptance

Session tests use the [suite harness and faux provider](packages/coding-agent/test/suite/README.md). After building the Node packages and Bun binary, run their installed-artifact checks from the repository root:

```sh
node scripts/mcp-acceptance.mjs
node scripts/mcp-acceptance.mjs --live-openrouter
```

The first command uses a faux provider. The optional second command uses the existing `OPENROUTER_API_KEY`, allows at most 12 requests with 4096 output tokens per request, disables retries, and refuses any router other than `openrouter/free`. Both use isolated configuration and synthetic MCP data. Live calls require explicit authorization and are outside default CI. The free router may select different underlying models; evaluate the recorded response model. JSONL reports under `node_modules/.cache/mcp-acceptance/` contain tool traces, results, backend models, usage, reported cost, and exit status without credentials. Set `CANDY_ACCEPTANCE_REPORT` to an existing report to preserve its request budget and skip successful scenarios when continuing after a diagnosed failure.
