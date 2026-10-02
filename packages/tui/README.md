# @candy/tui

Terminal components with differential rendering, keyboard input, focus, and application-owned scrolling. `TuiMainScreen` preserves terminal scrollback; `TuiAltScreen` owns a fullscreen viewport with layout, mouse input, and search.

```bash
npm install @candy/tui
```

## Start

```typescript
import { Input, ProcessTerminal, Text, TuiMainScreen, matchesKey } from "@candy/tui";

const tui = new TuiMainScreen(new ProcessTerminal());
const input = new Input();
input.onSubmit = (text) => {
  tui.addChild(new Text(text));
  input.setValue("");
  tui.requestRender();
};
tui.addChild(input);
tui.setFocus(input);
tui.addInputListener((data) => {
  if (matchesKey(data, "ctrl+c")) tui.stop();
});
tui.start();
```

Components render terminal lines for a supplied width and invalidate cached output when content or theme changes. Use terminal-width helpers rather than JavaScript string length. Applications own navigation and resource lifetime.

## References

- [Components](docs/components.md): layout, text, editing, selection, images, autocomplete, and key detection
- [Motion](docs/motion.md): animation clocks, progress, intensity, and disposal
- [Rendering and input](docs/rendering.md): renderer lifecycle, viewport layouts, overlays, mouse, focus, and IME
- [Public exports](src/index.ts) and [keybinding defaults](src/keybindings.ts)

Candy uses these components internally; extensions use its [host-rendered dialogs](../coding-agent/docs/extensions.md#ui-and-modes). For native helpers, see [Windows](native/win32/README.md), [macOS](native/darwin/README.md), and [Linux](native/linux/README.md).

Repository validation follows [AGENTS.md](../../AGENTS.md). The [chat example](test/chat-simple.ts) and package benchmark scripts exercise larger interfaces.

## License

MIT
