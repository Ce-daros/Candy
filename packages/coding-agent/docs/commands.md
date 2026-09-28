# Commands

Type `/` in an empty ordinary editor to open Command. Type to search commands and settings. Type `?` in an empty editor to open Help, where you can search Hotkeys and Changelog. Pasted prefixes and prefixes inside a message remain text. Press `Enter` to run a resource command without arguments, or to open a required local argument. Press `Right` on a resource command to enter optional arguments. The argument input preserves the full text you type. `Backspace` from an empty argument returns to the list, and `Backspace` from an empty search closes the panel. `Escape` goes back one level.

## Powerbar pages

Press `Ctrl+L` or click the editor's bottom border to open the Powerbar. `Left` and `Right` browse the highlighted selector; `Tab` moves between Model and Thinking.

| From | `Up` | `Down` |
|---|---|---|
| Model | Sources: providers, authentication, catalog, quick-selection scope | Details: highlighted model metadata and defaults |
| Thinking | History: context, compact, session details, rename, tree, fork, clone, resume | Agent: Instructions, Skills, Tools, Behavior |

Closing a page returns to its source selector. Details uses the highlighted model even if you have not selected it for the current session. A model without reasoning still has a Thinking selector with Off, so History and Agent remain available.

In Sources, `Space` toggles a model in quick selection. Select or clear an entire provider from its row. `Ctrl+A` includes every model matching the current search, `Ctrl+D` clears the matches, and `Tab` switches between search and the list.
If the search has no matches, the bulk actions leave the scope unchanged. Mouse selection moves focus to the clicked item.

Quick-selection edits are saved while browsing. Leaving the Sources root reconciles the active session model once: Candy keeps it if it remains available in the new scope, otherwise it selects the first available model in Powerbar order. If the scope contains no available models, Candy clears the active model. The saved default is unchanged, and starting or restoring a session does not reconcile its model. Select a model in the Powerbar before sending a message when no active model remains.

Provider pages show authentication state beside **Check authentication**: `Checking…`, the configured credential type and source, `Not connected`, or `Check failed` with its reason. A configured credential reports credential availability; it does not guarantee a network check succeeded.

Details displays the highlighted model's capabilities, context and output limits, and prices. Change default thinking with `Left` or `Right`, including the inherited value. Edit reserve and recent-token counts in place; `Enter` saves and `Escape` cancels. Press `Delete` on an overridden setting to restore inheritance. **Set as default** changes the startup model without switching the current session.

The Command list groups local actions, settings, and loaded resource commands under **Commands**, **Settings**, and **Resources**. Boolean and enumerated settings change from their rows. Resource commands retain their source label when names collide.

## Local actions

History includes these session actions:

| Action | Purpose |
|---|---|
| New session | Start a new session |
| Import | Import and resume a JSONL session |
| Export | Export the session as HTML or JSONL |

History groups Context, Compact, Session details, and Rename under the current session; Tree, Fork, Clone, Resume / Switch, and New session under Sessions; and Import and Export under Files.

Starting an empty session shows the Candy logo, version, counts for contexts, skills, prompts, and extensions, and one tip. Startup and **New session** use the same home view. The previous History, Command, and Hotkeys home links are available through their usual controls.

Project trust is available in Command under Privacy & Trust. `Ctrl+R` reloads keybindings, extensions, skills, templates, themes, and instructions. `Ctrl+X` copies the selection or the last assistant message. Command retains Debug for diagnostic output. Press `Ctrl+C` twice to quit, or `Ctrl+D` when the editor is empty.

Import, Export, and resource command argument inputs complete file paths. Cancelling the import confirmation keeps the path in the argument input.

Review a session before exporting it. Sessions can contain prompts, tool arguments, command output, file contents, and credentials exposed during the conversation.

Extensions, prompt templates, and skills can add commands. They appear under their registered names, with their source beside them. A skill named `pdf-tools` appears as `pdf-tools`; it is distinct from an extension or prompt template with the same name. The menu reflects resources loaded in the current session. Use Reload after adding or changing a command resource. See [Extensions](extensions.md), [Prompt Templates](prompt-templates.md), and [Skills](skills.md).

In Agent → Skills, `Enter` opens the selected skill file and returns to the same list position; `Space` toggles it. A running response or compaction blocks changes and shows the reason in the list. Agent → Tools uses `Space` to enable or disable tools and `Enter` to read their descriptions and parameters; saved defaults apply to the next session.
