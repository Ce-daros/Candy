# Prompt Templates

Prompt templates turn Markdown files into reusable entries in Command. Use one when you want to reuse the same prompt without adding executable behavior or a larger set of supporting instructions.

A template can accept arguments. candy can load templates from personal configuration, project configuration, an explicit path, or a candy package. Project configuration loads only after project trust is granted.

## Create a template

Create `~/.candy/agent/prompts/review.md`:

```markdown
---
description: Review staged git changes
argument-hint: "[focus]"
---
Review the staged changes. Focus on ${1:-correctness, security, and error handling}.
```

The filename becomes the Command entry name, so this template appears as **review**. The `description` appears in Command search results. If it is omitted, candy uses the first non-empty line.

`argument-hint` is optional. Use `<angle brackets>` for required arguments and `[square brackets]` for optional arguments.

Open Command and run **Reload** after adding or changing a template in an active session.

<a id="invoke-a-template"></a>

## Use a template

With an empty editor, press `/` to open Command and search for **review**. Press Enter to run it without arguments. To provide an optional argument, press `Right`, enter the text, then press Enter to send the expanded prompt. The editor treats other slash-prefixed text as ordinary message text. SDK callers can use `executeCommand({ source: "prompt", name: "review", args: "concurrency" })`.

Templates support these substitutions:

| Syntax | Result |
|---|---|
| `$1`, `$2`, … | One positional argument |
| `$@` or `$ARGUMENTS` | All arguments joined with spaces |
| `${1:-default}` | First argument, or a default value |
| `${@:-default}` | All arguments, or a default value |
| `${@:N}` | Arguments starting at position `N` |
| `${@:N:L}` | `L` arguments starting at position `N` |

Arguments follow shell-like quoting, so `"API compatibility"` supplies one argument containing a space.

<a id="choose-where-it-loads"></a>

## Add it to candy

Place the template in your user or project prompt directory. Conventional prompt directories load direct `.md` children only.

Settings and packages can select nested Markdown files; a package manifest can narrow discovery with explicit paths and globs. See [Settings](settings.md#resources) and [candy Packages](packages.md) for these options.

Project templates appear in Command after trust is granted. Review their content before trusting an unfamiliar project. See [Security](security.md#understand-project-trust).
