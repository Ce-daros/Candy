# Use candy in the terminal

Run `candy` from the folder you want to work in. candy uses that folder to discover files, instructions, and configuration, and to group saved sessions. If you have not installed candy or chosen a model yet, follow the [Quickstart](quickstart.md).

candy may ask whether you trust the working folder before loading its project resources. See [Project trust](security.md#understand-project-trust).

<p align="center"><img src="images/interactive-mode.png" alt="candy home screen with logo, shortcuts, prompt editor, and thinking level" width="750"></p>

The transcript separates conversation from machine activity: your messages start with a pink diamond, assistant prose remains unboxed, and consecutive tool calls form an activity line with status symbols. You write messages in the editor. Its bottom border shows the current model and thinking level; the top bar tracks context usage.

## Enter a prompt

Type a request and press `Enter` to send it. Use `Shift+Enter` to add a line, or press `Ctrl+G` to work on a longer prompt in your configured external editor.

To include files or images:

- Type `@` to search for a file and add it to your prompt.
- Press `Tab` to complete a path.
- Paste an image or drag it into a compatible terminal.

File suggestions appear above the editor, with the selected file's full path below the list. A long paste becomes an atomic `[paste #…]` marker; an image pasted from the clipboard becomes an `[Image #…]` marker showing its dimensions. Move, delete, or undo either marker as one unit. candy expands it to the original content or image path when sending. Click an image marker to see its stored path.

## Follow candy's work

candy shows each tool call and result in execution order. Completed reads and searches show a compact result summary. Edits, writes, and shell commands show up to five terminal rows by default; errors show up to twelve. Click a tool's title to expand that call. Press `Ctrl+O` to expand or collapse details across the transcript, or change the tool preview limit to 10 or 20 rows in Command. Cancelled calls have their own status. Thinking blocks start collapsed with a short excerpt; change their visibility with **Hide thinking** in Command.

The home screen shows the Candy logo, version, counts for contexts, skills, prompts, and extensions, and one tip. The editor border and six-step meter reflect the thinking level. Retry, compaction, and branch-summary status appears on the frame's top edge.

Open Command to change **UI animations** or **Animation intensity**. With animations off, panels and the frame appear immediately; level colors and status text remain visible. See [Terminal and display settings](settings.md#terminal-and-display).

candy does not ask before every tool call. Review commands and changed files, and use a sandbox for untrusted or unattended work. See [Security](security.md).

## Change direction

You can send more input while candy is working:

| What you want | Action |
|---|---|
| Adjust the current task | Type a message and press `Enter` |
| Add work after the current task | Type a message and press `Alt+Enter` |
| Return queued messages to the editor | Press `Alt+Up` |
| Stop the current task | Press `Escape` |

A message sent with `Enter` waits until the current response and its tool calls finish, then guides the next response. A follow-up sent with `Alt+Enter` waits until candy finishes the current task. Aborting returns queued messages to the editor.

The queue shows up to three pending messages and a total count. Expand it to inspect the rest. Steering and follow-up messages have separate labels.

Windows Terminal reserves some Alt shortcuts. See [Terminal Setup](terminal-setup.md) for the Windows alternatives.

## Powerbar and Command

Press `Ctrl+L` or click the model name in the editor border. `Left` and `Right` browse models, typing searches, `Enter` applies, and `Escape` cancels a preview. `Up`, `Down`, and `Tab` do nothing in model selection. `Shift+Tab` cycles the active model's thinking effort from the editor or during model selection.

Press `Escape` twice within 500ms in an empty ordinary editor to open Actions. Search for an action or browse its groups:

| Group | Actions |
|---|---|
| Models | Current Model, Sources |
| Current session | Context, Compact, Session details, Rename |
| Sessions | New session, Tree, Fork, Clone, Resume / Switch session |
| Files | Export, Import |
| Agent | Instructions, Skills, Tools, Behavior |

Current Model shows the active model's details and saved defaults. Sources manages provider access and the quick-selection scope. See [Models](models.md#select-a-model). Actions → Tools changes active tools or saves defaults for new sessions. Returning from a child page restores the menu's search and selection; closing Actions returns to the editor.

Type `/` in an empty ordinary editor to open Command, or `?` to open Help. Command searches actions, settings, and loaded extension/prompt/skill commands. A pasted slash or slash-prefixed message remains ordinary text. See [Commands](commands.md) for argument entry, completion, and explicit execution.

## Continue or start over

candy saves sessions automatically unless session persistence is disabled.

Use Actions to resume another saved session, rename the current session, inspect its details, navigate its tree, fork or clone, and compact context. Rename opens with the current session name filled in. **New session** in Actions starts a new session. See [Sessions and Context](sessions.md) for these workflows.

After leaving candy, run `candy --continue` from the same folder to resume its most recent session.

## Run a terminal command

With an empty editor, press `!` to enter Shell mode, type a command, and press `Enter`. Its output is included in the conversation:

```text
git status
```

Press `!` again while the Shell editor is empty to enter Shell · No Context. Commands in that mode run without sending output to the model. An empty-editor Backspace or Escape steps back one mode.

Shell commands appear as their own activity segment. The output preview keeps the most recent rows; expand the entry to read the full result.

## Copy or export results

Press `Ctrl+X` to copy the selected text or last assistant response. Choose Actions → Export to save the session as HTML or JSONL.

## Adjust the terminal

Candy runs fullscreen: the editor and status area stay fixed while the transcript scrolls within the terminal window. A title bar at the top shows the project, git branch, and session name.

Terminal support for mouse input, keyboard shortcuts, and inline images varies. See [Terminal Setup](terminal-setup.md) for platform-specific configuration and [Keybindings](keybindings.md) for every configurable shortcut. Open Help with `?` and choose **Hotkeys** to inspect the shortcuts active in your current session.

Use the transcript search shortcut from [Keybindings](keybindings.md#fullscreen) to search currently rendered text. Collapsed content is excluded until expanded. Search opens above the editor; closing it restores your draft and keeps the last viewed position.

## Collect diagnostic information

When troubleshooting terminal rendering or conversation state, choose **Debug** in Command. candy writes the rendered terminal lines and current session messages to `candy-debug.log` in your [agent directory](configuration.md#agent-directory).

Review this file before sharing it. It can contain prompts, model responses, tool output, file contents, and terminal data.
