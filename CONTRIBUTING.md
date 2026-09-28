# Developing Candy

Candy is an agent harness built for daily work in the terminal. It should feel quick, capable, and considered, from the first keystroke to the last tool result.

Candy began as a fork of pi and is developed independently. Useful upstream changes are evaluated individually and cherry-picked when they serve this product.

This document explains engineering decisions and contributions. [DESIGN.md](DESIGN.md) defines the product and interaction design. [AGENTS.md](AGENTS.md) contains the implementation, testing, dependency, and Git rules.

## Development philosophy

### Finish the workflow

A feature is ready when a person can use it to finish a task. Opening a page is only the beginning. Selection, editing, applying, cancelling, returning, and recovering from failure all belong to the work.

A provider's model list needs reliable checkbox controls, useful search, and bulk selection. Saving a model default needs a clear scope and must leave the current session model alone. These details determine whether a feature is usable.

Shared daily workflows belong in Candy. Extensions serve specialized workflows and integrations. Core size is a consequence of clear responsibilities; it is not a reason to leave common tasks unfinished.

### Make the product coherent

Give each action a natural home. Model sources belong in Sources, model configuration in Details, conversation history in History, and agent resources in Agent. Command provides explicit access to remaining operations and settings.

A new shortcut does not resolve confusing ownership. Start by deciding where an action belongs, what state it changes, and where the user returns. Keep those answers consistent across keyboard, mouse, and programmatic interfaces.

### Make effects explicit

Browsing, previewing, applying, and saving a default are different operations. Name and implement them accordingly.

Ordinary messages are text. Resource commands use an explicit source and name. An empty saved model scope means no models; it must not silently become all models. A value inherited from project configuration must not be presented as a newly saved user preference.

Represent these distinctions in types and state. Avoid recovering them later from labels, magic prefixes, or incidental control flow.

### Keep boundaries small and concrete

Presentation owns pages, focus, navigation, cancellation, and component lifetime. Runtime code owns authentication, model application, sessions, tools, resources, and persistence. Reusable TUI components own rendering and input behavior.

The Powerbar needs directional events and selection state. It does not need to understand provider authentication or become a registry for arbitrary pages. History should call the established session and tree flows. Another client should call the same business operations rather than reconstructing them from terminal input.

Extract a shared mechanism when real callers need the same behavior. Prefer a small typed interface with a clear owner. Every hook, abstraction, and configuration option adds a contract that someone must maintain.

### Preserve the user's work

Drafts, search queries, selection, and scroll position are working state. Cancelling a child page should restore the place the user left. Failure should keep the input needed to try again.

Async work belongs to the page and session that started it. A late catalog refresh must not reopen a closed page or move focus. Replacing a session must retire callbacks and resources from the previous session.

### Let failures be visible

Validate at the boundary where input becomes trusted. Report a concrete failure where the user can act on it. Do not add guessed types, broad catches, silent defaults, or compatibility branches to make an invalid state appear successful.

Supported terminal capabilities and configuration inheritance are explicit product behavior. Give them a defined contract. Do not invent a fallback whenever a code path is inconvenient.

Remove obsolete implementations and references when a replacement is complete. Introduce compatibility only when it is an explicit requirement, and document the migration when behavior changes.

### Treat feel as part of correctness

Candy has a colorful, lively terminal interface. Its color, motion, spacing, and feedback need the same care as its runtime.

An oversized gap that hides useful choices is a usability bug. A shortcut hint with the wrong binding is a correctness bug. A transition that drops input or leaves a timer running is an implementation bug. Shared components should make good behavior repeatable.

Use direct product language. Name the action, object, value, or failure. Keep implementation explanations in development documents and code where they help a reader understand a non-obvious decision.

### Verify the change, then finish

Read the relevant implementation before changing it. Use the application yourself when changing interaction. Choose tests that exercise observable behavior and the boundary most likely to break.

Run focused tests, fix the failures, and complete the required checks. Broaden coverage when the change or evidence warrants it. Repeating passing suites without new evidence is not progress.

Report what changed, what was verified, and what remains uncertain. A passing unit test does not establish that a terminal interaction feels right; a good-looking terminal capture does not establish that a setting persists.

## Contributing

### Describe the problem

Use the repository's issue templates. For a bug, include the shortest reproduction, expected and actual behavior, and relevant platform or terminal details. Remove credentials and private conversation content from logs.

For a feature, describe the task it enables and the interaction you expect. Discuss changes to product boundaries, public APIs, dependencies, or persistent formats before investing in a large implementation.

### Own the implementation

You must understand the code you submit and be able to explain its effects. AI assistance is welcome; the contributor remains responsible for the result, including generated tests and documentation.

Run coding agents from the repository root so they read [AGENTS.md](AGENTS.md). Understand the affected behavior, callers, and state before editing. Preserve concurrent work and keep changes tied to the problem being solved.

### Validate proportionately

After code changes, run `npm run check` from the repository root and the focused tests required by [AGENTS.md](AGENTS.md). When broader non-e2e coverage is justified, use `./test.sh`; do not invoke the full Vitest suite directly.

Changes to terminal input, focus, layout, or motion need a real terminal check. Windows PTY and Linux/tmux are supported verification environments. Use the [interactive testing guide](.candy/skills/interactive-testing.md) and isolated faux-provider fixtures; tests must not depend on personal credentials or paid model calls.

Documentation-only changes need a factual and link review. They do not require rerunning application suites.

### Submit a reviewable change

Keep the title and description centered on the problem and resulting behavior. Include relevant validation and any migration or known limitation. Update affected documentation and changelogs according to [AGENTS.md](AGENTS.md).

Group commits by coherent changes. Stage explicit paths, review the staged diff, and keep unrelated work out. A reviewer should be able to understand the result without reading the conversation that produced it.

## Maintenance notes

### Dependency maintenance

Review dependency and lockfile changes as code. Pin direct external dependencies to exact versions. When upgrading `undici`, read the target release notes and check their effect on existing behavior.

Use `npm install --ignore-scripts` for local dependency changes and `npm ci --ignore-scripts` for clean installs. Refresh the root lockfile with `npm install --package-lock-only --ignore-scripts` after dependency metadata changes.

Regenerate the coding-agent shrinkwrap with `node scripts/generate-coding-agent-shrinkwrap.mjs`; verify with `--check` or `npm run check`. A new dependency lifecycle script needs review and explicit authorization before adding it to that generator's allowlist. Respect the lockfile commit guard described in [AGENTS.md](AGENTS.md).

### Changelogs

Record changes in the affected package's `CHANGELOG.md`, under `## [Unreleased]`. Read the existing section, reuse its `Breaking Changes`, `Added`, `Changed`, `Fixed`, and `Removed` headings, and describe the resulting behavior. Include migration instructions for breaking APIs. Do not duplicate entries or modify released sections.

Add entries on `main` or a pull-request branch. Link related issues or pull requests when available and credit external contributors. Use the current repository for new links; preserve historical attribution.
