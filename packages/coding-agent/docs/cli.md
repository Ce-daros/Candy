<a id="cli-and-modes-reference"></a>

# Command Line

This page documents candy's built-in command-line commands and options. Run `candy --help` or append `--help` to a command for the exact interface in your installed version. The top-level help also includes options registered by loaded extensions.

```sh
candy [options] [--] [@files...] [messages...]
candy install <source> [options]
candy remove <source> [options]
candy uninstall <source> [options]
candy update [options]
candy list
candy config [options]
candy auth <check|print-api-key|print-bearer-token> [options]
candy mcp <add|remove|list|login|logout> [options]
```

<a id="modes"></a>

## Invocation and output

```sh
candy
candy --print "Summarize this repository"
git diff | candy --print "Review this change"
candy --mode json "Inspect this repository" > events.jsonl
```

With terminal stdin and stdout, candy opens the terminal UI unless `--print`, `--mode json`, or `--mode rpc` selects another interface. When either stream is redirected and neither JSON nor RPC mode is selected, candy uses print mode. See [CLI Integration](cli-integration.md) for choosing between interactive, print, JSON, RPC, and SDK integration.

| Input | Behavior |
|---|---|
| `message` | Provide an initial prompt |
| `@path` | Include a text file or image in the first prompt |
| Piped stdin | Prepend its contents to the first prompt |
| `--` | Stop option parsing so a prompt can begin with `-` |

candy resolves `@path` from the current working directory. The working directory also controls project configuration, resource discovery, and session grouping.

`--print` controls whether candy runs once and exits. `--mode` selects the output interface. `--mode text` does not force one-shot execution when stdin and stdout are terminals; use `--print` for that behavior.

| Option | Behavior |
|---|---|
| `-p`, `--print` | Run the supplied prompts, write the final assistant text to stdout, then exit |
| `--mode text` | Select text output; still open the terminal UI when stdin and stdout are terminals |
| `--mode json` | Run the supplied prompts, write JSONL events to stdout, then exit |
| `--mode rpc` | Read JSONL commands from stdin and write responses and events to stdout until shutdown |
| `--export <input> [output]` | Export a session file to HTML and exit; derive the destination when `output` is omitted |

RPC mode rejects `@file` arguments. JSON and RPC modes reserve stdout for protocol records. See [JSON Event Stream](json.md) and [RPC Protocol](rpc.md).

MCP server configuration and codemode behavior are described in [MCP and codemode](mcp.md). Use `candy mcp --help` for the installed server-management syntax.

<a id="model-options"></a>

## Models

```sh
candy --model sonnet:high
```

See [Choose a Model](models.md) for model selection and [Provider Authentication](providers.md) for credentials.

- `--provider <name>`<br>
  Restricts `--model` lookup to one provider. It requires `--model`.
- `--model <pattern>`<br>
  Selects by exact ID or fuzzy ID/name match. It accepts `provider/id` and an optional `:<thinking>` suffix.
- `--api-key <key>`<br>
  Uses a non-persistent API-key override. It requires a model selected through `--model`.
- `--thinking <level>`<br>
  Sets `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. It overrides a `--model` suffix and is clamped to the model's capabilities.
- `--list-models [search]`<br>
  Lists available models, optionally filtered by a fuzzy search, then exits.

<a id="session-options"></a>

## Sessions

```sh
candy --continue
```

See [Sessions and Context](sessions.md) for resuming, forking, naming, and storing sessions.

- `-c`, `--continue`<br>
  Continues the most recent session for the current project.
- `-r`, `--resume`<br>
  Opens the session selector.
- `--session <path|id>`<br>
  Opens by file path, exact ID, or partial ID. candy searches the current project first and offers to fork a cross-project match.
- `--session-id <id>`<br>
  Opens the exact project session ID or creates it if absent. IDs accept letters, numbers, `.`, `_`, and `-`.
- `--fork <path|id>`<br>
  Forks an existing session into a new session for the current project.
- `--session-dir <dir>`<br>
  Overrides storage and lookup. It takes precedence over `CANDY_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting.
- `--no-session`<br>
  Uses an in-memory session that is not persisted.
- `-n`, `--name <name>`<br>
  Sets the session display name.

Constraints:

- Session IDs must start and end with a letter or number.
- `--fork` cannot be combined with `--session`, `--continue`, `--resume`, or `--no-session`.
- `--session-id` cannot be combined with `--session`, `--continue`, or `--resume`. Combine it with `--fork` to choose the new ID.

<a id="tool-options"></a>

## Tools

```sh
candy --tools read,grep,find,ls --print "Review this project"
```

See [Settings](settings.md#tools) for configuring the default tool selection.

- `-t`, `--tools <list>`<br>
  Replaces the default selection with a comma-separated allowlist of built-in, extension, SDK, or MCP tools.
- `-xt`, `--exclude-tools <list>`<br>
  Disables comma-separated tool names after all other selection options.
- `-nbt`, `--no-builtin-tools`<br>
  Disables default built-in tools while retaining extension and MCP tools.
- `-nt`, `--no-tools`<br>
  Disables all tools, including extension and MCP tools.

Default tools are `read`, `bash`, `edit`, and `write`, unless `defaultTools` changes them. Codemode and search become available through enabled MCP tools. Include the desired MCP tool names in a restricted `--tools` list. [MCP tool availability and session choices](mcp.md#tool-availability-and-session-choices) defines activation, exclusions, and saved on/off choices.

| Built-in | Purpose |
|---|---|
| `read` | Read text files and supported images |
| `bash` | Run shell commands |
| `powershell` | Run PowerShell commands on Windows |
| `edit` | Apply exact text replacements to an existing file |
| `write` | Create or overwrite a file |
| `grep` | Search file contents |
| `find` | Find paths using glob patterns |
| `ls` | List directory contents |
| `codemode` | Call enabled MCP tools and process their results in sandboxed JavaScript |
| `search_mcp_tools` | Find currently callable MCP tool declarations with BM25 keyword search |

<a id="resource-options"></a>

## Resources

```sh
candy --extension ./review.ts
```

See [Configuration](configuration.md) for conventional directories and project trust, [Settings](settings.md#resources) for configured paths, and [candy Packages](packages.md) for package sources.

- `-e`, `--extension <path>`<br>
  Loads an extension file or directory and is repeatable.
- `-ne`, `--no-extensions`<br>
  Disables discovered and configured extensions. Explicit `-e` paths still load.
- `--skill <path>`<br>
  Loads a skill file or directory and is repeatable.
- `-ns`, `--no-skills`<br>
  Disables discovered and configured skills. Explicit `--skill` paths still load.
- `--prompt-template <path>`<br>
  Loads a prompt-template file or directory and is repeatable.
- `-np`, `--no-prompt-templates`<br>
  Disables discovered and configured templates. Explicit `--prompt-template` paths still load.
- `--theme <path>`<br>
  Loads a theme file or directory and is repeatable.
- `--use-theme <name[/name]>`<br>
  Selects the initial interactive theme for this run.
- `--no-themes`<br>
  Disables discovered and configured themes. Explicit `--theme` paths still load.
- `-nc`, `--no-context-files`<br>
  Disables `AGENTS.md` and `CLAUDE.md` discovery.

Resource paths apply only to the current process. Relative paths resolve from the current working directory.

<a id="prompt-and-display-options"></a>

## Prompts and process

```sh
candy --append-system-prompt ./instructions.md
```

See [Configuration](configuration.md) for saved configuration, [Security](security.md#understand-project-trust) for project trust, and [Environment Variables](environment-variables.md) for process controls.

- `--system-prompt <text|path>`<br>
  Replaces the default system prompt with text or the contents of an existing file.
- `--append-system-prompt <text|path>`<br>
  Appends text or an existing file to the system prompt and is repeatable.
- `--verbose`<br>
  Shows verbose interactive startup information, overriding `quietStartup`.
- `-a`, `--approve`<br>
  Trusts project-local configuration and resources for this process.
- `-na`, `--no-approve`<br>
  Ignores trust-gated project-local configuration and resources for this process.
- `--offline`<br>
  Disables automatic network activity, including model catalog refreshes. Equivalent to `CANDY_OFFLINE=1`.
- `-h`, `--help`<br>
  Shows help, including flags registered by loaded extensions, then exits.
- `-v`, `--version`<br>
  Shows the candy version, then exits.

Extensions may register additional long-form options. Unknown short options are rejected.

## Package commands

```sh
candy install npm:@scope/package
```

See [candy Packages](packages.md) for source formats, filtering, installation, and project scope.

### Common tasks

| Task | Command |
|---|---|
| Install a package | `candy install <source>` |
| List configured packages | `candy list` |
| Remove a package and its settings entry | `candy remove <source>` |
| Configure which package resources load | `candy config` |

Add `--local` or `-l` to `install`, `remove`, `uninstall`, or `config` to use project settings instead of global settings.

### Update packages

candy does not update itself. Upgrade it with your package manager, for example:
`npm install -g @candy/coding-agent@latest`.

| Task | Command |
|---|---|
| Update all installed packages | `candy update --extensions` |
| Update one installed package | `candy update <source>` |
| Refresh model catalogs | `candy update --models` |

### Aliases and command options

- `candy uninstall <source>` is an alias for `candy remove <source>`.
- `candy update --extension <source>` is an alias for `candy update <source>`. Running `candy update` without a target, `candy update --self`, `candy update self`, or `candy update candy` prints the manual upgrade instruction.
- `-a`, `--approve` trusts project-local files for one command. `-na`, `--no-approve` ignores trust-gated project-local files.
- Append `-h` or `--help` to a command for its exact usage and option constraints.

## Credential commands

```sh
candy auth check --provider openai --json
```

Authentication commands require `--provider <provider>` or `--model <model>`. See [Provider Authentication](providers.md) for supported methods.

| Command | Description |
|---|---|
| `candy auth check` | Print `ready`, `not_ready`, or `invalid`; exit with status `0`, `1`, or `2`, respectively |
| `candy auth print-api-key` | Print the resolved API key |
| `candy auth print-bearer-token` | Print a resolved OAuth bearer token |

| Option | Applies to | Description |
|---|---|---|
| `--provider <provider>` | All | Resolve credentials for a provider |
| `--model <model>` | All | Resolve credentials from a model; may be combined with `--provider` |
| `--json` | `auth check` | Write the structured result as JSON |
| `--credentials` | `auth check` | Emit the resolved credential when ready |
| `--no-refresh` | `auth check` | Do not refresh expired OAuth credentials; refresh is the default |
| `--min-expiry <duration>` | `print-bearer-token` | Require remaining token lifetime using `ms`, `s`, `m`, or `h`, such as `30m` |

Credential-printing commands write secrets to stdout.
