# Working on Candy

Candy began as a fork of pi and is developed independently. Useful upstream changes are evaluated individually and cherry-picked when they serve this product. Read [CONTRIBUTING.md](CONTRIBUTING.md) for development philosophy and [DESIGN.md](DESIGN.md) for product design.

## Working style

- Work toward the complete user goal. Make coordinated changes across modules, interfaces, tests, and documentation when the task requires them. Do not stop at a plan, a shortcut, or a partial implementation.
- Offer product and architecture judgments with concrete reasons. Discuss important tradeoffs, unclear goals, and changes outside the agreed scope with the user. Make routine implementation decisions yourself.
- Carry agreed decisions forward. Do not repeatedly ask for permission already given. An authorized refactor includes removing the implementations, entry points, and references it replaces; ask before removing unrelated working capabilities.
- Read enough of the implementation to understand behavior, callers, state ownership, and effects. Read key modules for broad changes; cover the affected paths for local changes. Search snippets alone are not an understanding of the system.
- Use the product yourself when changing interaction. Fix directly related usability gaps discovered along the way. Raise larger discoveries for discussion without abandoning the current goal.
- Answer questions directly. When responding to feedback, state your judgment and its reasons. Keep progress updates concise and explain meaningful decisions, evidence, and remaining uncertainty.
- Use concrete technical prose. Avoid filler, promotional claims, and emojis in commits, issues, PR comments, and code.

## Product and architecture

- Finish the whole workflow: discovery, input, selection, applying, cancelling, returning, and failure recovery. Follow the spatial model and visual rules in [DESIGN.md](DESIGN.md).
- Give product behavior a clear owner. Presentation owns navigation and focus; runtime owns business operations; shared TUI components own reusable rendering and input behavior.
- Reuse mature behavior and extract shared mechanisms when real callers need them. Avoid parallel implementations, speculative frameworks, and universal registries for a small set of concrete flows.
- Keep preview, active state, and saved defaults distinct. Preserve drafts, search, selection, and position; tie async callbacks and resources to their page and session lifetime.
- Do not hide errors with silent fallbacks, broad catches, guessed conversions, or speculative compatibility. Boundary validation, cancellation, and lifetime management should express real constraints.
- Remove obsolete code, comments, exports, and documentation as part of the change. Add backward compatibility only when explicitly required.
- Visible copy should name the action, value, or problem. Keep implementation explanations out of the product. Comment only non-obvious logic and decisions.

## Code constraints

- Use precise types; avoid `any` unless necessary. Check installed dependency types instead of guessing APIs.
- Use top-level imports. No dynamic imports or inline imported types.
- Code covered by the root TypeScript config uses Node strip-only syntax: no enums, parameter properties, namespaces, or other constructs requiring JS emit.
- In `packages/coding-agent`, resolve package assets through `src/config.ts` helpers rather than `__dirname`.
- Keep shortcuts configurable through `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`.
- Never hand-edit `packages/ai/src/models.generated.ts`. Update the generator and regenerate; resulting catalog changes may be included.
- Fix outdated dependencies rather than deleting working behavior to satisfy their types. Pin direct external dependencies to exact versions and review dependency and lockfile diffs.
- Use `npm install --ignore-scripts` or `npm ci --ignore-scripts`; run lifecycle scripts only when authorized. Follow the [dependency maintenance notes](CONTRIBUTING.md#dependency-maintenance).
- Write ad-hoc scripts to temporary files, run them, and remove them afterward.

## Validation and delivery

- Choose tests for the behavior and boundaries affected. Run every new or modified test and resolve failures. Use `test/suite/harness.ts` and the faux provider for coding-agent suite tests; do not use real credentials or paid model calls.
- Run focused tests from the package directory:
  - Vitest: `node <repo-root>/node_modules/vitest/dist/cli.js --run test/specific.test.ts`
  - TUI: `node --test test/specific.test.ts`
- Use `./test.sh` when broader non-e2e coverage is warranted. Do not run the full Vitest suite directly, or `npm test` / `npm run build` without a user request.
- At the end of code changes, run `npm run check`, retain its full output, and fix errors, warnings, and infos. It does not run tests. Avoid rerunning it after every small step.
- Once relevant tests and required checks pass, finish the task. Expand or repeat verification only for new changes, failures, or concrete unresolved concerns.
- For terminal input, focus, layout, or motion changes, follow the [interactive testing guide](.candy/skills/interactive-testing.md), including Windows PTY and Linux/tmux as appropriate to the affected behavior. Report what was actually exercised.
- Documentation-only changes need a factual, link, and diff review. Update affected package Unreleased entries using the [changelog notes](CONTRIBUTING.md#changelogs).
- Report the result, relevant validation, and material limitations. Never claim a behavior was verified without evidence.

## Workspace safety

- Other agents may be editing this checkout. Preserve their staged, unstaged, and untracked work. Do not overwrite changes you do not own.
- Commit only when the user asks. Stage explicit paths, inspect `git status` and the staged diff, and include only your work. Use concise `feat`, `fix`, or `docs` messages with an optional package scope.
- Never use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`, or force-push.
- Review PRs through diffs and refs without switching the shared checkout. Resolve rebase conflicts only in files you changed; abort and ask when another contributor's files conflict.
- Respect the lockfile commit guard. Set `CANDY_ALLOW_LOCKFILE_CHANGE=1` only when the user wants the lockfile change committed.
- DO NOT USE SUBAGENTS UNLESS USER ORDERED

## Architecture direction

- Prefer the active product architecture over compatibility with superseded APIs. Breaking internal and extension APIs is acceptable when it simplifies the system; migrate repository consumers and document the change.
- Keep one production runtime and persistence path. Remove experimental or unused parallel implementations together with their exports, dependencies, tests, examples, and documentation.
- Put business state and operations in runtime modules; keep terminal presentation and input handling in the interactive layer. Depend on narrow interfaces between these boundaries.
- Preserve user configuration and session data. Any persistence-format change must include an explicit migration and focused coverage.
- Optimize for useful behavior, performance, and a clear codebase. Split modules by real ownership and behavior, not by arbitrary file length.
