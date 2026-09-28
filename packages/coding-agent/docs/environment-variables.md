# Environment Variables

candy uses environment variables in three ways:

- Variables such as `CANDY_OFFLINE` configure the candy process.
- candy sets process markers so child processes can identify candy as the launching agent.
- Commands run by the LLM-callable shell tools receive `CANDY_*` variables describing the current session.

Provider API-key variables are documented separately in [Provider Authentication](providers.md#use-an-api-key-from-the-environment).

## Process Marker

The CLI and RPC entry points set two process markers:

- `CANDY_AGENT=candy` is a generic marker that lets tooling identify candy as the agent that launched the process.
- `CANDY_CODING_AGENT=true` lets child processes detect that they run inside candy.

Child processes inherit both markers. They are not session-specific and are not set automatically when candy is embedded through the SDK.

## Shell Tool Session Environment

Commands run by the `bash` and `powershell` tools receive the current candy session state:

| Variable | Description |
|----------|-------------|
| `CANDY_SESSION_ID` | Current session ID |
| `CANDY_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `CANDY_PROVIDER` | Currently selected model provider |
| `CANDY_MODEL` | Currently selected model ID |
| `CANDY_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting candy. `CANDY_PROVIDER` and `CANDY_MODEL` identify the selected candy model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$CANDY_PROVIDER" "$CANDY_MODEL"
printf 'reasoning=%s session=%s\n' "$CANDY_REASONING_LEVEL" "$CANDY_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$CANDY_SESSION_FILE" ]; then
  tail -n 1 "$CANDY_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable `bash` and `powershell` tools. They are not injected into commands entered in Shell or Shell · No Context mode.

### Custom Shell Tools

Tools created with `createBashTool()` or `createPowerShellTool()` expose the session environment by default when registered with candy. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, candy removes inherited values for these variables so nested candy processes do not expose stale parent-session metadata.

## candy Process Configuration

These variables are read by candy itself:

| Variable | Description |
|----------|-------------|
| `CANDY_CODING_AGENT_DIR` | Override the config directory; default is `~/.candy/agent` |
| `CANDY_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `CANDY_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `CANDY_OFFLINE` | Disable automatic network activity, including model catalog refreshes |
| `CANDY_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `CANDY_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `CANDY_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
| `CANDY_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
| `CANDY_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
| `CANDY_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and cloud-provider configuration are listed in [Provider Authentication](providers.md#use-an-api-key-from-the-environment).
