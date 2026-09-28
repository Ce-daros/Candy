# Commands

Type `/` in an empty ordinary editor to open Command. Type to search commands and settings. A pasted `/` and `/` inside a message remain text. Press `Enter` to run a resource command without arguments, or to open a required local argument. Press `Right` on a resource command to enter optional arguments. The argument input preserves the full text you type. `Backspace` from an empty argument returns to the list, and `Backspace` from an empty search closes Command. `Escape` goes back one level.

## Powerbar pages

Press `Ctrl+L` or click the editor's bottom border to open the Powerbar. `Left` and `Right` browse the highlighted selector; `Tab` moves between Model and Thinking.

| From | `Up` | `Down` |
|---|---|---|
| Model | Sources: providers, authentication, catalog, quick-selection scope | Details: highlighted model metadata and defaults |
| Thinking | History: context, compact, session details, rename, tree, fork, clone, resume | Agent: Instructions, Skills, Tools, Behavior |

Closing a page returns to its source selector. Details uses the highlighted model even if you have not selected it for the current session. A model without reasoning still has a Thinking selector with Off, so History and Agent remain available.

In Sources, `Space` toggles a model in quick selection. Select or clear an entire provider from its row. `Ctrl+A` includes every model matching the current search, `Ctrl+D` clears the matches, and `Tab` switches between search and the list.
If the search has no matches, the bulk actions leave the scope unchanged. Mouse selection moves focus to the clicked item.

## Command actions

Command includes individual settings and the following local actions:

| Action | Purpose |
|---|---|
| New | Start a new session |
| Import | Import and resume a JSONL session |
| Copy | Copy the last assistant message |
| Export | Export the session as HTML or JSONL |
| Trust | Save a project trust decision |
| Reload | Reload keybindings, extensions, skills, templates, themes, and instructions |
| Hotkeys | Show active shortcuts |
| Changelog | Show update notes |
| Debug | Write diagnostic output |
| Quit | Quit candy |

Import, Export, and resource command argument inputs complete file paths. Cancelling the import confirmation keeps the path in the argument input.

Review a session before exporting it. Sessions can contain prompts, tool arguments, command output, file contents, and credentials exposed during the conversation.

Extensions, prompt templates, and skills can add commands. They appear under their registered names, with their source beside them. A skill named `pdf-tools` appears as `pdf-tools`; it is distinct from an extension or prompt template with the same name. The menu reflects resources loaded in the current session. Use Reload after adding or changing a command resource. See [Extensions](extensions.md), [Prompt Templates](prompt-templates.md), and [Skills](skills.md).
