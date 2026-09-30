# SDK Examples

These examples use `createAgentSessionRuntime()` from `@candy/coding-agent`. The returned runtime owns the active session and its lifecycle. Read the current session from `runtime.session`, replace it through runtime operations, and await `runtime.dispose()` when the host is finished.

| File | Description |
|------|-------------|
| `01-minimal.ts` | Create, prompt, inspect, and dispose a runtime |
| `02-custom-model.ts` | Select a model and thinking level |
| `03-custom-prompt.ts` | Replace or append system-prompt instructions |
| `04-skills.ts` | Filter discovered skills and add a host-defined skill |
| `05-tools.ts` | Choose built-in tools and working directory |
| `06-extensions.ts` | Load extension files and register an inline factory |
| `07-context-files.ts` | Add host-provided project instructions |
| `08-prompt-templates.ts` | Add a host-defined prompt template |
| `09-api-keys-and-oauth.ts` | Configure credentials and model storage |
| `10-settings.ts` | Supply settings and await a persisted change |
| `11-sessions.ts` | Use memory or persistent session managers |
| `12-full-control.ts` | Supply custom model, settings, and resource services |
| `13-session-runtime.ts` | Replace the active session through the runtime |

Run an example from `packages/coding-agent` after building the package:

```bash
node examples/sdk/01-minimal.ts
```

The examples use the SDK's headless defaults. `resourceLoaderOptions` customizes discovery without importing terminal UI code. The loader disables theme discovery when no `themeAdapter` is supplied. Hosts that need themes can import `resourceThemeAdapter` from `@candy/coding-agent/ui`.

Extension files are evaluated in the host process. The SDK supplies the core extension modules by default. If an extension imports `@candy/coding-agent/ui`, pass `extensionModules` from `@candy/coding-agent/extension-host-modules` to `createAgentSessionRuntime()` so the extension loader can resolve that subpath.
