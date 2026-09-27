# Use candy in the terminal

Run `candy` from the folder you want to work in. candy uses that folder to discover files, instructions, and configuration, and to group saved sessions. If you have not installed candy or chosen a model yet, follow the [Quickstart](quickstart.md).

candy may ask whether you trust the working folder before loading its project resources. See [Project trust](security.md#understand-project-trust).

<p align="center"><img src="images/interactive-mode.png" alt="candy interactive mode showing a conversation, editor, and status information" width="750"></p>

The transcript shows your prompts, candy's responses, tool calls, results, and errors. You write prompts and commands in the editor. The editor's bottom border shows the current model and thinking level.

## Enter a prompt

Type a request and press `Enter` to send it. Use `Shift+Enter` to add a line, or press `Ctrl+G` to work on a longer prompt in your configured external editor.

To include files or images:

- Type `@` to search for a file and add it to your prompt.
- Press `Tab` to complete a path.
- Paste an image or drag it into a compatible terminal.

## Follow candy's work

candy shows each tool call and result while it works. Press `Ctrl+O` to expand or collapse tool output. Press `Ctrl+T` to show or hide thinking blocks.

The startup header lists the instructions and resources candy loaded. The default editor frame draws itself when a session starts. While candy generates a response, two brighter trails move around the frame; retrying, compacting, and branch summarization use their own trail patterns. The current thinking level changes trail length and peak brightness. Trails keep the frame's cyan color, or yellow in Shell mode. The top bar tracks context usage.

Use `/settings` to change **UI animations** or **Animation intensity**. With animations off, the frame appears immediately and a short status word replaces the moving trails. See [Terminal and display settings](settings.md#terminal-and-display).

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

Windows Terminal reserves some Alt shortcuts. See [Terminal Setup](terminal-setup.md) for the Windows alternatives.

## Change the model or settings

Type `/` to search the available commands. The commands you will use most often are:

- `/model` selects a model. Press `Ctrl+L` to open the inline selector, then `Tab` to move to thinking level or `Shift+Tab` to move back.
- `/thinking` selects how much reasoning the current model uses. Press `Shift+Tab` to cycle through supported levels.
- `/login` and `/logout` manage provider access.
- `/settings` changes common preferences.

Prompt templates, skills, and extensions can add more commands to the same menu. See [Choose a Model](models.md), [Configuration](configuration.md), or the complete [Slash Commands reference](slash-commands.md).

## Continue or start over

candy saves sessions automatically unless session persistence is disabled.

- `/new` starts a new session.
- `/resume` opens another saved session.
- `/name` gives the current session a recognizable name.
- `/session` shows its file, ID, message count, token usage, and cost.

Use `/tree`, `/fork`, or `/clone` when you want to explore another approach without losing existing work. Use `/compact` to reduce the conversation history sent to the model. See [Sessions and Context](sessions.md) for these workflows.

After leaving candy, run `candy --continue` from the same folder to resume its most recent session.

## Run a terminal command

With an empty editor, press `!` to enter Shell mode, type a command, and press `Enter`. Its output is included in the conversation:

```text
git status
```

Press `!` again while the Shell editor is empty to enter Shell · No Context. Commands in that mode run without sending output to the model. An empty-editor Backspace or Escape steps back one mode.

## Copy, export, or share results

Press `Ctrl+X` or run `/copy` to copy the last assistant response. Use `/export` to save the session as HTML or JSONL.

Use `/share` to upload the session and get a viewer link. With Radius authentication, the artifact is visible to your Radius organization. Otherwise, candy creates a private GitHub gist through the GitHub CLI. Review the session first because it can contain prompts, tool output, file contents, and credentials exposed during the conversation.

## Adjust the terminal

Candy runs fullscreen: the editor and status area stay fixed while the transcript scrolls within the terminal window. A title bar at the top shows the project, git branch, and session name.

Terminal support for mouse input, keyboard shortcuts, and inline images varies. See [Terminal Setup](terminal-setup.md) for platform-specific configuration and [Keybindings](keybindings.md) for every configurable shortcut. Run `/hotkeys` to inspect the shortcuts active in your current session.

## Collect diagnostic information

When troubleshooting terminal rendering or conversation state, run `/debug`. candy writes the rendered terminal lines and current session messages to `pi-debug.log` in your [agent directory](configuration.md#agent-directory).

Review this file before sharing it. It can contain prompts, model responses, tool output, file contents, and terminal data.
