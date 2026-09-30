# Sessions and Context

candy saves a conversation as a session. The active branch of that session supplies conversation history for the next model request. Open Thinking → History to continue work, explore another branch, or reduce the amount of history sent to the model.

## Continue or switch sessions

candy saves sessions automatically unless you start it with `--no-session`.

```bash
candy --continue
candy --resume
```

`--continue` opens the most recent session for the current working directory. `--resume` opens the session picker. In interactive mode, History → Resume / Switch session opens the same picker; Command → New starts a new session.

Use History → Rename or `--name` to assign a recognizable session name. History → Session details shows the current session file, ID, message count, token usage, and cost.

The session picker shows each name, summary, time, and message count in a wide list, with more information below the selected row. It lets you search, rename, and delete sessions with confirmation. It can also show paths, change sorting, and limit results to named sessions. See [Keybindings](keybindings.md#sessions) for its shortcuts.

## Choose how to branch

candy stores entries as a tree, so returning to an earlier point does not erase the branch you leave.

| Action | Result | Use it when |
|---|---|---|
| Tree | Moves within the current session file | Related alternatives should stay together |
| Fork | Creates a new session from an earlier user message | The alternative should become separate work |
| Clone | Copies the active branch into a new session | You want a separate copy of the current state |

In History → Tree, each branch entry occupies one row and its complete content appears below the list. Select a user message to put its text back in the editor. Edit and submit it to create another branch. Selecting an assistant response or another entry continues after that entry with an empty editor. History → Fork shows two-line summaries of user messages and previews the complete selected message below them.

When you leave a branch, candy can summarize it and attach that summary to the branch you enter. This preserves relevant work from the abandoned path without including every message from it.

For the persisted tree and entry types, see [Session Format](session-format.md).

## Manage conversation context

The model receives the active branch, not every branch in the session file. candy combines that history with the system prompt, discovered context files, available tools, and loaded skill descriptions. [How candy Works](how-candy-works.md#context) describes how those inputs are assembled.

The top bar shows current context usage. When the active context approaches the model's limit, candy normally compacts older history automatically. Compaction adds a collapsible summary and keeps recent messages. It does not delete the original session entries.

Choose Compact in History to compact manually. You can add instructions when the summary should preserve a particular topic or decision. Configure automatic compaction and retained history through [Settings](settings.md#compaction).

Compaction can fail if the provider is unavailable or cannot accept the summarization request. Correct the provider problem and choose Compact again. Disabling automatic compaction does not disable the manual action.

See [Compaction Reference](compaction.md) for thresholds, retained boundaries, and branch-summary behavior.

## Control session storage

By default, candy stores sessions under `~/.candy/agent/sessions/`, grouped by working directory. Use `--session-dir`, `CANDY_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting to choose another location. The CLI option has highest precedence.

Use `--no-session` for an ephemeral run. An ephemeral session cannot be resumed after candy exits.

Use `--session` when you already know the session path or ID. Use `--fork` to create a new session from an existing session before interactive mode starts.

## Export a session

Choose Export in Command to write the current session as HTML or JSONL.

Review exported sessions first. They can contain prompts, model responses, tool arguments, command output, file contents, and extension messages.
