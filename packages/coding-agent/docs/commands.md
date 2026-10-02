# Commands

Type `/` in an empty ordinary editor to open Command. It groups local actions, settings, and loaded resource commands under Commands, Settings, and Resources. Type to search; Boolean and enumerated settings change directly from their rows. Debug is the local diagnostic action; Project trust is under Privacy & Trust.

Type `?` in an empty editor to open Help for Hotkeys and Changelog. Pasted prefixes and prefixes inside messages remain text. See [Usage](usage.md#powerbar-and-command) for Powerbar navigation and [Sessions](sessions.md) for Actions.

## Resource commands

Extensions, prompt templates, and skills appear under their registered names with source labels. A skill named `pdf-tools` appears as `pdf-tools`; the source distinguishes it from a prompt or extension with that name. Press Ctrl+R after adding or changing resources.

| Control | Result |
|---|---|
| Enter | Run without arguments, or open required arguments |
| Right on a resource | Enter optional arguments |
| Backspace with empty arguments | Return to the list |
| Backspace with empty search | Close Command |
| Escape | Return one level |

Arguments preserve the complete string. Path arguments offer completion. Failure retains arguments. Local actions return to Command; prompts and skills that send a message return to the conversation.

SDK and RPC callers discover resources with their structured APIs and execute them using `source`, `name`, and `args`. Ordinary message APIs do not dispatch commands. Built-in model and session operations retain their own APIs. See [SDK](sdk.md#prompting-and-events) and [RPC commands](rpc-commands.md#discoverable-commands).

Use [Extensions](extensions.md), [Prompt Templates](prompt-templates.md), and [Skills](skills.md) for resource formats and registration.
