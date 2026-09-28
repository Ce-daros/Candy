# Quickstart

candy runs in your terminal and works with files on your machine. To use it, you need access to a model through a supported provider. This can be a subscription, an API key, or a local model.

For native Windows setup, read [Windows Setup](windows.md). For Android, read [Termux Setup](termux.md).

## 1. Install candy

On macOS or Linux, you can use the installer:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Alternatively, install candy from npm. This requires Node.js 22.19 or newer:

```bash
npm install -g --ignore-scripts @candy/coding-agent
```

candy does not require dependency lifecycle scripts for a normal npm installation.

Verify the installation:

```bash
candy --version
```

## 2. Start candy

Change to the folder you want candy to work with, then start it:

```bash
cd /path/to/folder
candy
```

The working folder helps candy discover relevant files, instructions, and configuration. candy also uses it to group saved sessions.

<p align="center"><img src="images/interactive-mode.png" alt="candy home screen with logo, shortcuts, prompt editor, and thinking level" width="750"></p>

The home screen shows the Candy logo and current controls. Your conversation appears above the prompt editor. The editor's lower border shows the model and thinking level; the top bar tracks context usage. See [Use candy in the terminal](usage.md) to learn how to add files, open Command, direct ongoing work, and manage results.

## 3. Choose a model

A **model** generates candy's responses. A **provider** is the service or account candy uses to access that model.

Press `Ctrl+L` to open Model, then `Up` for Sources. Choose a provider and connect a subscription or store an API key. Return to Model and use `Left` or `Right` to choose an available model.

See [Choose a model and provider](models.md) for supported providers, environment-variable authentication, local models, and custom endpoints.

## 4. Give candy a task

candy shows each file read, search, command, and edit it performs. It does not ask before every tool call.

Enter a task that matches your work, for example:

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

Type `@` in the editor to search for a file instead of entering its full path. When candy finishes, review its response and any changed files. Use version control or backups for important work. For untrusted or unattended work, use a container or another sandbox. See [Security](security.md).

## Continue later

candy saves sessions automatically. Exit candy, then resume the most recent session for the same working folder with:

```bash
candy --continue
```

Open Thinking → History → Resume / Switch session to choose another saved session. See [Continue or branch a session](sessions.md) for session naming, branching, compaction, and export.

## Next steps

- [Use candy interactively](usage.md) to learn input, commands, shortcuts, and queued messages.
- [Add instructions](configuration.md#context-files) that candy should follow whenever it works in a folder.
- [Choose a model and provider](models.md).

### Choose how to customize candy

Start with the least powerful mechanism that meets your need:

| Need | Start with |
|---|---|
| Give candy persistent instructions for a folder | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt from Command | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Extension](extensions.md) |
| Build a custom terminal component | [Terminal UI](tui.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Install or distribute several resources | [candy package](packages.md) |

## Uninstall candy

If you installed candy with npm, run:

```bash
npm uninstall -g @candy/coding-agent
```

If you used the installer, run it again and choose **Uninstall candy**:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Neither method removes configuration, credentials, sessions, or installed candy packages from `~/.candy/agent/`.
