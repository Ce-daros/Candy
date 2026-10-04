# MCP and codemode

Candy connects to Model Context Protocol servers over stdio or Streamable HTTP. It requests protocol **2026-07-28** and uses the client SDK's version negotiation with older servers. The negotiated version appears in **Actions → MCP servers**.

## Configure a server

Define `mcpServers` in `<agent-dir>/mcp.json` (normally `~/.candy/agent/mcp.json`) or the trusted project's `.candy/mcp.json`:

```json
{
  "mcpServers": {
    "local-data": {
      "command": "node",
      "args": ["/absolute/path/to/server.js"]
    },
    "remote-data": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

| Connection | Fields |
|---|---|
| stdio | `command`, with optional `args`, `env`, and `cwd` |
| HTTP | `url`, with optional `headers` and `oauth` (`clientId`, `clientMetadataUrl`, `scope`) |

Configured connection values can refer to environment variables. OAuth credentials are stored in `<agent-dir>/mcp-auth.json`. Set `enabled: false` to prevent a connection.

A project entry replaces the user entry with the same name. An entry containing only `enabled` or `exposure` overrides those settings while keeping the user's connection details. Project configuration loads only after [project trust](security.md#understand-project-trust).

### Manage servers

```sh
candy mcp add local-data -- node /absolute/path/to/server.js
candy mcp add remote-data --url https://example.com/mcp
candy mcp list --json
candy mcp login remote-data
candy mcp logout remote-data
candy mcp remove local-data
```

`add` and `remove` accept `--project`. HTTP `add` also accepts `--client-id` or `--client-metadata-url`; run `candy mcp --help` for the complete syntax.

In the terminal, **Actions → MCP servers** or **Command → mcp** shows connection status, transport, negotiated protocol, tool count, and errors. Select a server to reconnect, enable or disable it, change exposure, log in, or log out. Enabled state and exposure can be saved globally or for the trusted project.

## Use codemode

The server's `exposure` determines how its tools reach the model:

| Exposure | Model interface |
|---|---|
| `codemode` (default) | `search_mcp_tools` discovers declarations; `codemode` executes calls and processes results |
| `direct` | Each enabled MCP tool has its own model-facing definition |
| `hidden` | Tools are unavailable to the model |

### Discover and execute

First call the ordinary JSON tool `search_mcp_tools`:

```json
{ "query": "query records" }
```

BM25 ranks tool names, descriptions, and server metadata, returning up to 10 matches. Each match in `{ "tools": [...] }` contains a callable `name` and a `description` with complete parameter and return-value declarations. Use English keywords for English descriptions. No matching keywords produces `{ "tools": [] }`; refine the query rather than guessing a name. Search does not execute MCP calls.

After inspecting the declaration, pass a JavaScript async function body to codemode. For the synthetic `fixture` server:

```javascript
const records = await Promise.all([1, 2, 3].map(id => tools.mcp_fixture_query({ id })));
return { total: records.reduce((sum, result) => sum + result.structuredContent.amount, 0) };
```

This returns `{"total":60}`. Scripts can batch or chain calls, filter, sort, deduplicate, and aggregate their results. Use `bash` for standalone calculations and local data processing.

### Output and state

Top-level `await` and `return` work. Use `text(value)`, `image(dataUrlOrImageBlock)`, or a returned value to produce model-visible output; a bare expression produces none. Each execution starts with fresh variables. The sandbox has no Node APIs, file system, network, timers, or discovery functions. Do not redeclare globals such as `tools`, `text`, `image`, `store`, or `load`.

`store(key, value)` and `load(key)` retain JSON values on the current session branch. Successful scripts commit writes; failed or cancelled scripts do not. Forking or navigating the tree uses the corresponding branch's state. Failed scripts cannot undo external effects from calls already made.

## Tool availability and session choices

Search and execution share the same set of currently enabled MCP tools with `codemode` exposure. Built-in tools, ordinary extension/SDK tools, and direct or hidden MCP tools are outside that set.

| Situation | Availability |
|---|---|
| At least one qualifying MCP tool is enabled | Codemode and search are added as its execution and discovery path |
| No qualifying tools are enabled or connected | Both helpers are hidden |
| Codemode is explicitly closed or excluded | Both helpers are hidden; server exposure stays unchanged |
| `search_mcp_tools` is excluded | Only the search helper is hidden |
| All tools are disabled | Neither helper is available |

Explicit startup selections replace the ordinary `read,bash,edit,write` defaults. MCP tools can still activate their codemode helpers. A restricted CLI `--tools` list must include the MCP tool names: `--tools read,codemode` offers only `read`, while `--tools read,mcp_fixture_query,codemode` also offers both helpers for that query tool. See [CLI tool options](cli.md#tools) and [SDK tool options](sdk.md#tool-selection).

A user's explicit codemode on/off choice is saved on the current branch. It survives resume, reload, and MCP reconnection. Forks inherit the choice at their fork point; tree navigation reads the target branch. An explicit startup tool selection takes precedence over the saved choice. Sessions without a recorded choice use automatic MCP activation. An enabled preference is retained while qualifying tools are unavailable and takes effect when they return. Search follows codemode and has no separate persistent choice.

## Results and interaction

MCP resource lists, templates, and content can be read through connected servers. Text and images use the normal result pipeline. Audio and binary resources are saved to temporary files, with paths and MIME types returned to the model. Use an explicit file operation for permanent artifacts. MCP Prompts, Apps, and Tasks are outside the current interface.

When a tool requests a form or URL, Candy asks while it runs. Submit sends entered values, Decline refuses, and Cancel stops the interaction. A URL opens only after **Open link** is selected. Print and JSON modes cannot supply interactive input; use the terminal or an RPC client for these tools.

## SDK and RPC

`runtime.mcp.list()` returns server states. `reload()` reloads configuration and connections; `reconnect(name)` reconnects one server. `setEnabled`, `setExposure`, `login`, and `logout` manage server settings and credentials. Settings operations accept `global` or `project` scope. `setInteraction(handler)` supplies host UI for elicitation and authorization; the handler receives the server, request, and cancellation signal and returns an MCP `ElicitResult`. Runtime disposal closes connections.

RPC uses the same server states and operations. See [MCP server commands](rpc-commands.md#mcp-server-commands) for command and response shapes, and [MCP elicitation](rpc-extension-ui.md#mcp_elicitation) and [authorization](rpc-extension-ui.md#mcp_authorization) for the UI exchange.
