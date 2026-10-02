# Terminal UI integration

Candy owns its interactive renderer, editor, navigation, and focus. Extensions use [host-rendered dialogs and text updates](extensions.md#interact-with-the-user).

Hosts building their own terminal interface can use `@candy/tui`; Candy UI helpers are exported through `@candy/coding-agent/ui`. See the TUI package's [component reference](../../tui/docs/components.md) and [rendering, focus, mouse, and IME reference](../../tui/docs/rendering.md).

## Apply themes correctly

Use the theme supplied by the application embedding a component. Theme helpers produce ANSI-styled strings for semantic colors such as accent, muted text, success, warnings, errors, tool output, and Markdown.

Use `theme.style()` to combine foreground and background colors with text attributes:

```typescript
return new Text(
  theme.style("Done!", {
    fg: "success",
    bg: "toolSuccessBg",
    bold: true,
  }),
  0,
  0,
);
```

A style color can be a semantic theme token or a concrete `Color`. Foreground tokens are accepted as `fg` and background tokens as `bg`; to use a token's color in the other position, pass its concrete color, for example `{ fg: theme.colors.userMessageBg }`. Access concrete colors through `theme.colors` and use utilities such as `mixColors()` from `@candy/tui` when color math is needed. Tokens that a theme sets to the terminal default render with the terminal's own color; `theme.colors` reports the color the terminal announced for them, or a guess when it did not. Use `theme.appearance` (`"dark"` or `"light"`) to decide, for example, whether to lighten or darken a color. candy converts the result to truecolor or 256-color output based on terminal capabilities. Theme tokens are converted once per theme; compute concrete colors outside the render path when possible.

`theme.fg()` and `theme.bg()` apply one semantic color.

Do not permanently store strings with theme colors unless `invalidate()` rebuilds them. A theme change clears render caches, but it cannot remove old ANSI colors embedded in application state.

Theme callbacks evaluated during rendering do not need special rebuilding. Stateless components can also calculate themed output on every render.

Use [Themes](themes.md) to create terminal palettes. Use candy’s `getMarkdownTheme()` when rendering Markdown that should match the active application theme.
