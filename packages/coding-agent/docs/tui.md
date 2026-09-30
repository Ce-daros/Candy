# Terminal UI

`@candy/tui` provides terminal components and rendering utilities. Candy extensions use the host-owned dialogs and text updates described in [Extensions](extensions.md#interact-with-the-user); they do not install components into Candy's interface.

Use this package when building a terminal interface that owns its rendering, input, focus, layout, and lifecycle.

## Choose an integration point

| Need | Use |
|---|---|
| Compose a terminal view | Components such as `VStack`, `Box`, and `ScrollView` |
| Read text or a selection | `Input`, `Editor`, or `SelectList` |
| Render Markdown or images | `Markdown` or `Image` |

Import public components from `@candy/coding-agent/ui` or `@candy/tui` where the package contract allows them.

## Understand the component model

A component renders an array of terminal lines for an available width. It can optionally handle keyboard and mouse input, and it must invalidate cached output when its state or theme-dependent content changes.

Every rendered line must fit within the supplied width. Measure visible terminal columns rather than string length because ANSI escapes, wide characters, emoji, and combining characters change display width.

Use `visibleWidth()`, `truncateToWidth()`, `sliceByColumn()`, and `wrapTextWithAnsi()` instead of implementing terminal-width handling yourself. candy resets styling and hyperlinks after every line, so reapply styles on each rendered line.

After changing component state, invalidate the affected component and call the injected `tui.requestRender()`. The TUI coalesces render requests and updates the terminal.

## Compose built-in components

The package includes components for common layouts and controls:

- `Text`, `Markdown`, `Image`, and `TruncatedText` render content.
- `Container`, `VStack`, `HStack`, `Box`, and `Spacer` compose layouts.
- `Input` and `Editor` accept text.
- `SelectList` and `SettingsList` implement searchable selection and settings flows.
- `ScrollView` provides a bounded scrollable viewport.
- `Loader` and `CancellableLoader` report ongoing work.
- `MouseRegion` adds pointer behavior around another component.

Prefer these components over rebuilding selection, scrolling, text editing, or width handling.

## Handle keyboard input and focus

Use `matchesKey()` and `Key` for terminal keyboard input. The parser accounts for supported terminal protocols and key modifiers.

A component that displays a text cursor should implement `Focusable` and place `CURSOR_MARKER` immediately before its visual cursor. The TUI uses that marker to position the hardware cursor for input method editors.

Containers that wrap an `Input` or `Editor` must propagate their `focused` state to that child. Without propagation, Chinese, Japanese, Korean, and other IME candidate windows can appear at the wrong screen position.

Candy owns the interactive application editor and its surrounding interface. This package does not provide an extension hook for replacing those surfaces.

## Handle mouse input

Fullscreen mode routes normalized mouse events to components. A handler can mark an event handled, capture a drag sequence, request focus, or request a render.

Unhandled wheel events scroll the nearest `ScrollView`. Unhandled primary-button drags remain available for transcript selection. OSC 8 links take precedence over enclosing click regions.

Candy always runs fullscreen and owns the viewport, so design every interaction with a keyboard path alongside mouse handling.

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

The existing `theme.fg()` and `theme.bg()` helpers remain available for applying one semantic color.

Do not permanently store strings with theme colors unless `invalidate()` rebuilds them. A theme change clears render caches, but it cannot remove old ANSI colors embedded in application state.

Theme callbacks evaluated during rendering do not need special rebuilding. Stateless components can also calculate themed output on every render.

Use [Themes](themes.md) to create terminal palettes. Use candy’s `getMarkdownTheme()` when rendering Markdown that should match the active application theme.

## Keep rendering responsive

Rendering runs on the interactive path. Cache expensive layout and highlighting work by width and content, then clear that cache from `invalidate()`.

Keep the default view compact and reveal detail through expansion or a dedicated screen.

Use `CANDY_TUI_WRITE_LOG` to capture the raw ANSI stream when diagnosing rendering problems. Test narrow widths, wide characters, resize events, theme changes, and focus transitions.

## Source


The public exports are defined in [`packages/tui/src/index.ts`](../../tui/src/index.ts). See [Extensions](extensions.md) for extension lifecycle, state, tools, events, and host-owned interaction methods.
