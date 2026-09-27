# Use candy in the terminal

Run `candy` from the folder you want to work in. candy uses that folder to discover files, instructions, and configuration, and to group saved sessions. If you have not installed candy or chosen a model yet, follow the [Quickstart](quickstart.md).

candy may ask whether you trust the working folder before loading its project resources. See [Project trust](security.md#understand-project-trust).

<p align="center"><img src="images/interactive-mode.png" alt="candy home screen with logo, shortcuts, prompt editor, and thinking level" width="750"></p>

The transcript separates conversation from machine activity: your messages start with a pink diamond, assistant prose remains unboxed, and consecutive tool calls form an activity line with status symbols. You write prompts and commands in the editor. Its bottom border shows the current model and thinking level; the top bar tracks context usage.

## Enter a prompt

Type a request and press `Enter` to send it. Use `Shift+Enter` to add a line, or press `Ctrl+G` to work on a longer prompt in your configured external editor.

To include files or images:

- Type `@` to search for a file and add it to your prompt.
- Press `Tab` to complete a path.
- Paste an image or drag it into a compatible terminal.

Slash commands, files, and arguments appear in an autocomplete panel attached above the editor. The selected file's full path appears below its list. A long paste becomes an atomic `[paste #…]` marker; an image pasted from the clipboard becomes an `[Image #…]` marker showing its dimensions. Move, delete, or undo either marker as one unit. candy expands it to the original content or image path when sending. Click an image marker to see its stored path.

## Follow candy's work

candy shows each tool call and result in execution order. Completed reads and searches show a compact result summary. Edits, writes, and shell commands show up to five terminal rows by default; errors show up to twelve. Click a tool's title to expand that call. Press `Ctrl+O` to expand or collapse details across the transcript, or change the tool preview limit to 10 or 20 rows in `/settings`. Cancelled calls have their own status. Thinking blocks start collapsed with a short excerpt; press `Ctrl+T` to change their visibility.

The home screen shows the Candy logo, `/resume`, `/settings`, `/hotkeys`, and one tip. Loaded resources start as a summary that you can expand to inspect names and paths. The editor border, six-step meter, and moving trails reflect the selected thinking level: gray at Off and Minimal, blue at Low, pink at Medium, cyan at High, and flowing color with brighter highlights at Xhigh and Max. Shell mode uses yellow for its command title. Retry, compaction, and branch-summary status appears on the frame's top edge.

Use `/settings` to change **UI animations** or **Animation intensity**. With animations off, panels and the frame appear immediately; level colors and status text remain visible. See [Terminal and display settings](settings.md#terminal-and-display).

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

## Change the model or settings

Type `/` to search the available commands. The commands you will use most often are:

- `/model` opens a provider and model panel. Search by model name, ID, or provider; the detail area shows the full ID and capabilities. Press `Ctrl+L` for the footer's inline model selector, then `Tab` to move to thinking level or `Shift+Tab` to move back.
- `/thinking` selects how much reasoning the current model uses. Press `Shift+Tab` to cycle through supported levels.
- `/login` and `/logout` manage provider access.
- `/settings` opens five categories: Appearance, Conversation & Input, Models & Connection, Privacy & Trust, and Terminal. Search settings from the panel's bottom input.

Panels grow upward from the editor. Use `Tab` or `Shift+Tab` to move between their regions, arrow keys to move through a list, `Enter` to confirm, and `Escape` to return or close. Where a panel offers a directory or configuration scope, use `Alt+S` to switch it. Closing a panel restores the editor draft and cursor.

Prompt templates, skills, and extensions can add more commands to the same menu. See [Choose a Model](models.md), [Configuration](configuration.md), or the complete [Slash Commands reference](slash-commands.md).

## Continue or start over

candy saves sessions automatically unless session persistence is disabled.

- `/new` starts a new session.
- `/resume` opens another saved session.
- `/name` gives the current session a recognizable name.
- `/session` opens a read-only view of its file, ID, message count, token usage, and cost.

Use `/tree`, `/fork`, or `/clone` when you want to explore another approach without losing existing work. Use `/compact` to reduce the conversation history sent to the model. See [Sessions and Context](sessions.md) for these workflows.

After leaving candy, run `candy --continue` from the same folder to resume its most recent session.

## Run a terminal command

With an empty editor, press `!` to enter Shell mode, type a command, and press `Enter`. Its output is included in the conversation:

```text
git status
```

Press `!` again while the Shell editor is empty to enter Shell · No Context. Commands in that mode run without sending output to the model. An empty-editor Backspace or Escape steps back one mode.

Shell commands appear as their own activity segment. The output preview keeps the most recent rows; expand the entry to read the full result.

## Copy, export, or share results

Press `Ctrl+X` or run `/copy` to copy the last assistant response. Use `/export` to save the session as HTML or JSONL.

Use `/share` to upload the session and get a viewer link. With Radius authentication, the artifact is visible to your Radius organization. Otherwise, candy creates a private GitHub gist through the GitHub CLI. Review the session first because it can contain prompts, tool output, file contents, and credentials exposed during the conversation.

## Adjust the terminal

Candy runs fullscreen: the editor and status area stay fixed while the transcript scrolls within the terminal window. A title bar at the top shows the project, git branch, and session name.

Terminal support for mouse input, keyboard shortcuts, and inline images varies. See [Terminal Setup](terminal-setup.md) for platform-specific configuration and [Keybindings](keybindings.md) for every configurable shortcut. Run `/hotkeys` to inspect the shortcuts active in your current session.

Use the transcript search shortcut from [Keybindings](keybindings.md#fullscreen) to search currently rendered text. Collapsed content is excluded until expanded. Search opens above the editor; closing it restores your draft and keeps the last viewed position.

## Collect diagnostic information

When troubleshooting terminal rendering or conversation state, run `/debug`. candy writes the rendered terminal lines and current session messages to `pi-debug.log` in your [agent directory](configuration.md#agent-directory).

Review this file before sharing it. It can contain prompts, model responses, tool output, file contents, and terminal data.
