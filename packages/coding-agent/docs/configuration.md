# Configuration

candy supports user-level and project configuration. User-level configuration lives in the agent directory, which defaults to `~/.candy/agent`. Project configuration lives in `.candy` under the working directory and loads after [project trust](security.md#understand-project-trust) is granted. The only exception is `sessionDir`, which candy reads before resolving trust so it can locate sessions.

In interactive mode, type `/` in an empty editor to open Command and change common preferences. For other options, ask candy to update the configuration or edit the relevant files directly. Choose Reload in Command after manually changing settings, keybindings, instructions, or resources.

Run `candy config` to choose which package resources load. Its panel groups extensions, skills, prompts, and themes by package and source. It shows each resource's path and whether the current scope inherits, enables, or disables it. Use `Alt+S` to switch between user and project settings.

## Agent directory

The agent directory is shown as `<agent-dir>` below. Set its location with the `CANDY_CODING_AGENT_DIR` environment variable or the SDK's [`agentDir`](sdk.md) option.

| Path | Responsibility |
|---|---|
| `<agent-dir>/settings.json` | User-level [settings](settings.md), including preferences, defaults, resource paths, and candy package declarations. |
| `<agent-dir>/keybindings.json` | Custom terminal UI and application [keybindings](keybindings.md). |
| `<agent-dir>/models.json` | [Compatible endpoints, models, and model overrides](models.md#configure-a-compatible-endpoint). |
| `<agent-dir>/auth.json` | Saved API keys and OAuth credentials. |
| `<agent-dir>/AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD` | User instructions applied across working directories. |
| `<agent-dir>/SYSTEM.md` | Replaces candy’s default system prompt. |
| `<agent-dir>/APPEND_SYSTEM.md` | Adds instructions to candy’s system prompt. |
| `<agent-dir>/extensions/` | User [extensions](extensions.md). |
| `<agent-dir>/skills/` | User [skills](skills.md) and supporting files. |
| `<agent-dir>/prompts/` | User [prompt templates](prompt-templates.md) available in Command. |
| `<agent-dir>/themes/` | User [theme](themes.md) files. |

## Project `.candy` directory

| Path | Responsibility |
|---|---|
| `.candy/settings.json` | Project-level [settings](settings.md), resource paths, and candy package declarations. |
| `.candy/SYSTEM.md` | Replaces the system prompt for the project. |
| `.candy/APPEND_SYSTEM.md` | Adds project-specific instructions to the system prompt. |
| `.candy/extensions/` | Project extensions. |
| `.candy/skills/` | Project skills and supporting files. |
| `.candy/prompts/` | Project prompt templates available in Command. |
| `.candy/themes/` | Project theme files. |

For `SYSTEM.md` and `APPEND_SYSTEM.md`, the trusted project file takes precedence over the corresponding agent-directory file. Files with the same name are not combined.

## Context files

Context files are separate from project `.candy` configuration. candy loads them from the agent directory, the working directory, and its parent directories. A context file applies whenever candy runs in its directory or anywhere below it.

An `AGENTS.override.md` replaces `AGENTS.md` or `CLAUDE.md` only in the same directory. It does not suppress context files from the agent directory or other directories.

Context-file discovery does not require project trust.
