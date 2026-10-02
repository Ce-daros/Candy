---
name: interactive-testing
description: Test Candy's interactive mode in a real terminal with isolated faux models and sessions.
---

# Interactive testing

The source smoke launcher builds the current TypeScript checkout with esbuild and starts Candy with two faux models, a session tree, and an isolated home, workspace, temp directory, auth store, and session directory. It blocks network requests. Run it from the repository root after dependencies are installed.

On Windows, use a real PowerShell or Windows Terminal PTY:

```powershell
node scripts/interactive-smoke.mjs --no-animations
```

Check Ctrl+L, model browse/search/confirm/cancel, ignored Up/Down/Tab keys, Shift+Tab effort cycling, double Escape opening Actions, Current Model, Sources, session actions, Instructions/Skills/Tools/Behavior, child-page return, Command (`/` on an empty input), paste, and Chinese input. Press Ctrl+D to exit. Omit `--no-animations` to check motion. Resize the terminal between 80 columns and a wider layout.

Use `--startup-dialogs` to exercise first-time setup, project trust, the startup session picker, session-name input, and a simulated login before the main interface. Cancel or confirm each startup page, then enter `fake-key` in the simulated API-key prompt. The fixture displays its waiting state briefly and continues to the main interface. Its device-code link uses `example.test`, and no authentication request is made. Combine this flag with `--no-animations` or `--light` as needed.

On Linux, use tmux to send real keys and capture the display:

```bash
tmux new-session -d -s candy-smoke -x 80 -y 24 -c "$PWD"
tmux send-keys -t candy-smoke 'node scripts/interactive-smoke.mjs --no-animations' Enter
sleep 2
tmux capture-pane -t candy-smoke -p
tmux send-keys -t candy-smoke C-l
tmux send-keys -t candy-smoke Escape
sleep 0.1
tmux send-keys -t candy-smoke Escape
sleep 0.1
tmux send-keys -t candy-smoke Escape
sleep 0.2
tmux capture-pane -t candy-smoke -p
tmux resize-window -t candy-smoke -x 120 -y 36
tmux capture-pane -t candy-smoke -p
tmux send-keys -t candy-smoke C-d
tmux kill-session -t candy-smoke
```

Repeat without `--no-animations` to inspect transitions. For release smoke tests, start the release binary in a separate tmux session outside the checkout, test Node and Bun binaries separately, submit a prompt, and wait for the model reply; startup alone is insufficient.

Record the runtime version, compile target, reply, and exit code. On Linux x64 machines without AVX2, Bun 1.3.14 requires the `bun-linux-x64-baseline` compile target; check CPU flags before choosing the target. Keep packaged Node assets under the package root's `dist/` directory and Bun assets next to the executable.
