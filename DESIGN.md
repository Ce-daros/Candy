# Designing Candy

Candy should feel compact, responsive, and alive. The conversation stays readable, controls stay close to the work, and color and motion give the interface a recognizable character.

This document records the current product model and the rules used to extend it. Engineering principles live in [CONTRIBUTING.md](CONTRIBUTING.md); implementation rules live in [AGENTS.md](AGENTS.md).

## Character

Candy's personality comes from precise interaction and a bright palette: pink, purple, cyan, blue, yellow, and lime. Quiet text and restrained surfaces give those colors room to work. The editor frame can breathe and respond to activity while the conversation remains stable.

Give frequent actions short paths, fit useful choices on screen, and provide immediate feedback. Large empty areas, repeated explanations, decorative badges, and unnecessary confirmations spend attention without helping the task.

The standard is a tool someone wants to keep open all day. A polished opening screen cannot compensate for awkward selection, lost drafts, or a confusing return path.

## The conversation is the workspace

Messages, reasoning, and tool activity form one conversation. The composer remains the place to write, issue a shell command, or enter Command. Supporting pages open within this working context.

An empty session shows the Candy logo, version, counts for contexts, skills, prompts, and extensions, and one tip. Starting a session with `/new` or History uses the same home. Remove that home when the first real user message arrives, including image-only input.

Keep the transcript readable during streaming. Preserve a user's position when they scroll into earlier content. Resizing, opening a page, or updating status must not unexpectedly take over their focus.

Progress describes real runtime state. Errors remain inspectable. Visual activity must not imply success before completion or imply active work while the agent is idle.

## A stable spatial model

The Powerbar has two horizontal selectors. Left and Right browse choices. Tab cycles between Model and Thinking. Up and Down open related pages.

| Selector | Left / Right | Up | Down |
|---|---|---|---|
| Model | Model choices | Sources | Details of the highlighted model |
| Thinking | Supported reasoning levels | History | Agent |

Ctrl+L and mouse interaction open the selectors. Shift+Tab has no Powerbar action. Up and Down must not become alternate ways to browse horizontal choices.

Thinking stays available for models without reasoning, with Off as its only choice. An empty model scope still allows access to Sources. A search with no matches cannot open Details for some other model.

Opening a page captures its origin: selector, search, highlighted identity, and visible position. Closing it restores that origin. Cancelling a nested selector returns to its parent page. A successful session replacement returns to Thinking while following the existing draft handling rules.

### Sources

Sources answers where models come from. Providers are the primary grouping, with authentication, available account information, catalog state, and quick-selection scope together.

Checkboxes change the models offered by quick selection. They do not switch the session model. Space toggles the focused model. Provide select-all and clear actions for a provider, and bulk actions for the current search results. Empty results must not modify the scope.

Save the scope at user level using explicit provider/model identities. Unset means all available models; an empty list means none. Preserve unavailable configured entries and show their state. Temporary authentication or catalog failure must not erase a choice.

Apply an edited scope when leaving the Sources root, after returning from provider pages. Keep the current model when it remains available in the new scope; otherwise select the first available model in Powerbar order. If none is available, clear the active model and require a selection before sending. Opening or restoring a session does not reconcile its model.

Show authentication checks beside their action: checking, configured credential type and source, not connected, or check failed with its reason. A configured credential does not necessarily mean the provider was reached over the network.

### Details

Details is the highlighted model's card and configuration. It must work before that model is selected for the session.

Show actual catalog data: provider, model ID, supported input, reasoning, context and output limits, and price where available. Keep model-specific defaults here, including thinking and compression token settings. Global settings belong in Command. Group facts by capability, limits, and price; keep effective values and their source on each setting row.

Saving a default changes startup configuration without applying the model to the current conversation. Distinguish the saved value, its configuration source, and the effective value. Clearing an override restores inheritance.

Cycle thinking values in place, including inherited. Edit token counts in place; Enter saves and Escape cancels. Delete restores inheritance when the selected setting has an override. “Set as default” changes startup configuration without changing the current session.

### History

History joins the current conversation with work from other sessions. It includes Context, Compact, Session details, Rename, Tree, Fork, Clone, Resume / Switch session, New session, Import, and Export.

Use the established session, tree, and user-message selectors. Keep their summary choices, branch navigation, and draft behavior. A new entry point should not introduce a second implementation of session history.

### Agent

| Section | Responsibility |
|---|---|
| Instructions | Inspect effective instructions and sources; edit source files and reload. |
| Skills | Inspect content and sources; enable or disable resources and their Command availability. |
| Tools | Inspect descriptions and parameters; manage session tools and saved defaults. |
| Behavior | Configure steering delivery, follow-up queuing, and automatic retry. |

Use the existing resource and reload mechanisms. If an operation cannot apply during a run, preserve the edit and show the specific reason. Profiles and Plan / Act are not part of the current model.

## Input has explicit modes

The composer distinguishes ordinary input, Shell, Shell No Context, Command, and Help. The active mode must be visible before submission.

Only a separately typed `/` in an empty ordinary editor enters Command. Pasted text, programmatically inserted text, and `/` inside a message remain text. Ordinary message APIs do not dispatch commands or expand templates.

Command offers searchable operations and settings in Commands, Settings, and Resources groups, including Project trust under Privacy & Trust. Boolean and enumerated settings change from their rows. Extensions, prompts, and skills use their bare command names, with source information to distinguish collisions. A skill does not need a `skill:` prefix.

A separately typed `?` in an empty ordinary editor opens Help for Hotkeys and Changelog. Pasted prefixes remain text. Reload uses Ctrl+R; session creation and file exchange belong in History.

An operation without parameters runs on Enter. A required argument opens a focused argument input. Resource commands run without arguments on Enter or open optional arguments with Right. Preserve the complete argument string and existing completion. Complex operations use dedicated interfaces rather than a universal generated form.

Backspace edits nonempty input. From empty arguments it returns to the command list; from empty search it exits Command. Escape returns one level. Failures retain arguments. Local operations return to Command; a skill or prompt that sends a message returns to the conversation.

Programmatic resource execution uses source, name, and arguments through `executeCommand` or RPC `execute_command`. Structured model and session operations keep their business APIs. Clients share these meanings even when their layouts differ. See the [Command reference](packages/coding-agent/docs/commands.md).

## Selection, focus, and persistence

Browsing highlights an item. Preview changes temporary presentation. Applying changes active state. Saving a default changes persisted configuration. Keep these effects separate in behavior and labels.

Give focus one clear owner. Keyboard input goes to that owner; clicking a control transfers focus to it. Space in a search field is text, while Space on a checkbox changes selection. Hints describe the focused control.

Returning restores working state. Editing an existing value begins with that value. Bulk operations show their scope and preserve selections outside it. A busy or unavailable action explains the obstacle without discarding input.

Tie async callbacks to the page and session that started them. Leaving a page releases its subscriptions and timers. A late result may refresh valid data, but it cannot remount an old page or steal focus.

## Visual language

### Color

Use semantic theme roles rather than literal colors in components. Light mode uses darker values of the same hues for contrast.

| Hue | Dark | Light | Principal use |
|---|---|---|---|
| Purple | `#B967FF` | `#7641B0` | Accent text and selected labels |
| Cyan | `#40E2FF` | `#007F99` | Selection markers, active borders, keycaps |
| Pink | `#FC70B4` | `#A42E67` | User prompt and primary Markdown headings |
| Blue | `#4D81F6` | `#1246C2` | Links and syntax keywords |
| Yellow | `#FFD32F` | `#8A6400` | Shell mode, warnings, syntax functions |
| Lime | `#B8E45A` | `#567300` | Success and added diff lines |
| Red-pink | `#F25D83` | `#B72F54` | Errors and removed diff lines |

Color reinforces a readable label, marker, or state. Essential information must remain understandable without motion or color discrimination. Reuse the [theme roles](packages/coding-agent/docs/themes.md) and built-in [dark](packages/coding-agent/src/modes/interactive/theme/dark.json) and [light](packages/coding-agent/src/modes/interactive/theme/light.json) definitions.

### Keycaps

Instructional keycaps use angle brackets: `<Space>`, `<Ctrl+Z>`, `<Enter>`. The entire keycap, including both brackets, uses cyan through the shared `borderAccent` role. Surrounding explanations use the secondary text color.

Render hints from active keybindings through the shared helpers. Preserve platform-specific names and complete alternatives. Do not cut a keycap in half to fit a description.

### Density and layout

Design at 80 columns first, then use wider terminals well. Spend width on meaningful labels and values. Reduce gaps before hiding useful choices; truncate long model names while preserving identifying parts. Keep mouse hit regions aligned with visible items.

Composer panels use at most 80 percent of terminal rows and shrink to their rendered content when it is shorter. Keep footers and error details within the viewport; scroll long lists and readers inside their content.

The expanded Thinking selector shows level names such as Off, Minimal, Low, Medium, and High. It has no per-option energy bars. The collapsed frame may retain its existing level meter. Model and Thinking choices use compact, stable slots so moving the highlight does not push neighboring labels around.

Account for terminal display width rather than JavaScript string length. Chinese text, combining characters, ANSI styles, cursor placement, and resizing are part of layout correctness. A wide-screen capture alone is insufficient evidence.

### Motion

Motion communicates where a page came from, which choice is being previewed, and whether work is active. Use shared frame and panel transitions so timing and intensity remain consistent.

Input takes priority over animation. Quick navigation, cancellation, and reopening must reach the user's latest intended state without queuing obsolete transitions. Preserve spatial continuity and release timers when their owner leaves.

Respect `uiAnimations` and `animationIntensity`. With animations disabled, selection, focus, completion, and error feedback remain clear. Reuse existing timing and intensity controls rather than giving each page its own animation system.

### Language

Use short, specific labels: “Set as default”, “Clear”, “Rename”. Show facts that support a decision, such as configuration source or authentication state.

Errors name the failed operation and a useful next step when one is known. Transcript errors and warnings use a semantic marker, a narrow side rail, and a readable reason; long details remain expandable. Cancellation stays muted. Keep the raw reason available for selection and copying. Do not claim success before completion. Keep internal field names, implementation plans, and explanations of the page's purpose out of normal product copy.

Candy's visual personality carries the expression. Avoid marketing language, repeated instructions, and commentary about how helpful or powerful a feature is.

## Implementation ownership

| Layer | Owns |
|---|---|
| Powerbar | Horizontal choices, highlight, search, preview, animation, directional events |
| Interactive presentation | Page ownership, origin, child flows, focus, cancellation, lifetime |
| Runtime and configuration | Authentication, catalogs, model application, sessions, tools, resource loading, saved values |
| Shared TUI components | Rendering, input primitives, geometry, reusable selection and panel behavior |
| SDK, RPC, experimental clients | Explicit access to shared operations and their own presentation |

Share settings definitions and mutations across entry points. Share resource enablement with configuration tooling. Extend a mature selector when its behavior fits; do not copy its implementation into another page.

Keep abstractions tied to actual responsibilities. Adding a page should not require a universal UI registry, a generic form protocol, or product-specific cases in the base editor.

## Reviewing a design change

Walk through the complete interaction: discover, open, navigate, change, apply, cancel, return. Include empty data, no results, unavailable resources, and failure where relevant.

Verify the boundary affected. Navigation needs focus and return-state checks; configuration needs scope and persistence checks; async work needs lifetime checks. Terminal interaction changes need hands-on Windows PTY and Linux/tmux verification with narrow and wide layouts, Chinese input or paste, and animations on and off.

Use the isolated [interactive smoke launcher](scripts/interactive-smoke.mjs) and [testing guide](.candy/skills/interactive-testing.md). Stop expanding the test run when the affected behavior is covered and required checks pass. Record remaining limitations honestly.
