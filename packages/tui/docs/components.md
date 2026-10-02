# Components

### Container

Groups child components.

```typescript
const container = new Container();
container.addChild(component);
container.removeChild(component);
```

### Box

Container that applies padding and background color to all children.

```typescript
const box = new Box(
  1,                              // paddingX (default: 1)
  1,                              // paddingY (default: 1)
  (text) => chalk.bgGray(text)   // optional background function
);
box.addChild(new Text("Content"));
box.setBgFn((text) => chalk.bgBlue(text));  // Change background dynamically
```

### Text

Displays multi-line text with word wrapping and padding.

```typescript
const text = new Text(
  "Hello World",                  // text content
  1,                              // paddingX (default: 1)
  1,                              // paddingY (default: 1)
  (text) => chalk.bgGray(text)   // optional background function
);
text.setText("Updated text");
text.setCustomBgFn((text) => chalk.bgBlue(text));
```

### TruncatedText

Single-line text that truncates to fit viewport width. Useful for status lines and headers.

```typescript
const truncated = new TruncatedText(
  "This is a very long line that will be truncated...",
  0,  // paddingX (default: 0)
  0   // paddingY (default: 0)
);
```

### Input

Single-line text input with horizontal scrolling.

```typescript
const input = new Input();
input.onSubmit = (value) => console.log(value);
input.setValue("initial");
input.getValue();
```

Clicking positions the cursor and gives the input keyboard focus in alternate-screen mode.

Pass `{ mask: true }` to the constructor for secrets. Masking changes only the displayed characters; `getValue()` and `onSubmit` receive the original input. `setMasked()` can change this behavior for an existing input.

**Key Bindings:**
- `Enter` - Submit
- `Ctrl+A` / `Ctrl+E` - Line start/end
- `Ctrl+W` or `Alt+Backspace` - Delete word backwards
- `Ctrl+U` - Delete to start of line
- `Ctrl+K` - Delete to end of line
- `Ctrl+Left` / `Ctrl+Right` - Word navigation
- `Alt+Left` / `Alt+Right` - Word navigation
- Arrow keys, Backspace, Delete work as expected

### Editor

Multi-line text editor with autocomplete, file completion, paste handling, and vertical scrolling when content exceeds terminal height.

```typescript
interface EditorTheme {
  borderColor: (str: string) => string;
  selectList: SelectListTheme;
  textColor?: (str: string) => string;
  pathColor?: (str: string) => string;
  markerColor?: (str: string) => string;
}

interface EditorOptions {
  paddingX?: number;  // Horizontal padding (default: 0)
}

const editor = new Editor(tui, theme, options?);  // tui is required for height-aware scrolling
editor.onSubmit = (text) => console.log(text);
editor.onChange = (text) => console.log("Changed:", text);
editor.disableSubmit = true; // Disable submit temporarily
editor.setAutocompleteProvider(provider);
editor.borderColor = (s) => chalk.blue(s); // Change border dynamically
editor.setPaddingX(1); // Update horizontal padding dynamically
editor.getPaddingX();  // Get current padding
editor.setViewportLines(12); // Bound the editor's content height
```

**Features:**
- Click-to-position cursor and clickable autocomplete rows in alternate-screen mode
- Multi-line editing with word wrap
- File path autocomplete (press `Tab`)
- Large paste handling (>10 lines creates `[paste #1 +50 lines]` marker)
- Horizontal lines above/below editor
- Fake cursor rendering (hidden real cursor)
- `insertImageAtCursor(path, dimensions)` inserts an atomic image marker; `onImagePath` receives the original path when its label is clicked

**Key Bindings:**
- `Enter` - Submit
- `Shift+Enter` or `Ctrl+J` - New line
- `Tab` - Autocomplete
- `Ctrl+K` - Delete to end of line
- `Ctrl+U` - Delete to start of line
- `Ctrl+W` or `Alt+Backspace` - Delete word backwards
- `Alt+D` or `Alt+Delete` - Delete word forwards
- `Ctrl+A` / `Ctrl+E` - Line start/end
- `Ctrl+]` - Jump forward to character (awaits next keypress, then moves cursor to first occurrence)
- `Ctrl+Alt+]` - Jump backward to character
- Arrow keys, Backspace, Delete work as expected

### Markdown

Renders markdown with syntax highlighting and theming support.

```typescript
interface MarkdownTheme {
  heading: (text: string) => string;
  headingLevel?: (level: number, text: string) => string;
  link: (text: string) => string;
  linkUrl: (text: string) => string;
  code: (text: string) => string;
  codeBlock: (text: string) => string;
  codeBlockBorder: (text: string) => string;
  codeBlockLabel?: (text: string) => string;
  tableHeader?: (text: string) => string;
  quote: (text: string) => string;
  quoteBorder: (text: string) => string;
  hr: (text: string) => string;
  listBullet: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
  underline: (text: string) => string;
  highlightCode?: (code: string, lang?: string) => string[];
}

interface DefaultTextStyle {
  color?: (text: string) => string;
  bgColor?: (text: string) => string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
}

const md = new Markdown(
  "# Hello\n\nSome **bold** text",
  1,              // paddingX
  1,              // paddingY
  theme,          // MarkdownTheme
  defaultStyle    // optional DefaultTextStyle
);
md.setText("Updated markdown");
```

The optional sixth constructor argument accepts `MarkdownOptions`; the fifth is `DefaultTextStyle`. `maxProseWidth` limits paragraphs while code and tables retain the full width. `onCopyCode` enables the code block's Copy control and receives its original source. `codeBlockView(code, language, width, complete)` can provide an alternate rendering, such as a diagram; `complete` is true only after the closing fence appears. The reader can switch between the alternate view and source in the rendered block.

**Features:**
- Headings, bold, italic, code blocks, lists, links, blockquotes
- HTML tags rendered as plain text
- Optional syntax highlighting via `highlightCode`
- Padding support
- Render caching for performance

### Loader

Animated loading spinner.

```typescript
const loader = new Loader(
  tui,                              // TUI instance for render updates
  (s) => chalk.cyan(s),            // spinner color function
  (s) => chalk.gray(s),            // message color function
  "Loading..."                      // message (default: "Loading...")
);
loader.start();
loader.setMessage("Still loading...");
loader.stop();
```

### CancellableLoader

Extends Loader with Escape key handling and an AbortSignal for cancelling async operations.

```typescript
const loader = new CancellableLoader(
  tui,                              // TUI instance for render updates
  (s) => chalk.cyan(s),            // spinner color function
  (s) => chalk.gray(s),            // message color function
  "Working..."                      // message
);
loader.onAbort = () => done(null); // Called when user presses Escape
doAsyncWork(loader.signal).then(done);
```

**Properties:**
- `signal: AbortSignal` - Aborted when user presses Escape
- `aborted: boolean` - Whether the loader was aborted
- `onAbort?: () => void` - Callback when user presses Escape

### SelectList

Interactive selection list with keyboard navigation.

```typescript
interface SelectItem {
  value: string;
  label: string;
  description?: string;
  inline?: (width: number) => string;
}

interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

const list = new SelectList(
  [
    { value: "opt1", label: "Option 1", description: "First option" },
    { value: "opt2", label: "Option 2", description: "Second option" },
  ],
  5,      // maxVisible
  theme   // SelectListTheme
);

list.onSelect = (item) => console.log("Selected:", item);
list.onCancel = () => console.log("Cancelled");
list.onSelectionChange = (item) => console.log("Highlighted:", item);
list.setFilter("opt"); // Filter items
```

An `inline` renderer receives the space remaining after the label, selection markers, and gap. The normal label still determines the shared primary column width. Use this for an input that replaces one row's description without moving other descriptions. `getSelectedRow()` returns the selected row's index within the visible list.

**Controls:**
- Mouse wheel: Move the selection
- Click: Select a row
- Arrow keys: Navigate
- Enter: Select
- Escape: Cancel

### SettingsList

Settings panel with value cycling and submenus.

```typescript
interface SettingItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];  // If provided, Enter/Space cycles through these
  submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

interface SettingsListTheme {
  label: (text: string, selected: boolean) => string;
  value: (text: string, selected: boolean) => string;
  description: (text: string) => string;
  cursor: string;
  hint: (text: string) => string;
  keycap: (key: string) => string;
}

const settings = new SettingsList(
  [
    { id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
    { id: "model", label: "Model", currentValue: "gpt-4", submenu: (val, done) => modelSelector },
  ],
  10,      // maxVisible
  theme,   // SettingsListTheme
  (id, newValue) => console.log(`${id} changed to ${newValue}`),
  () => console.log("Cancelled")
);
settings.updateValue("theme", "light");
```

`SettingsList` implements `Focusable` and forwards focus to its active search input or submenu. Switching its submenu, editing values, and searching update the existing list immediately.

**Controls:**
- Mouse wheel: Move the selection
- Click: Activate a row
- Arrow keys: Navigate
- Enter/Space: Activate (cycle value or open submenu)
- Escape: Cancel

### Spacer

Empty lines for vertical spacing.

```typescript
const spacer = new Spacer(2); // 2 empty lines (default: 1)
```

### Image

Renders images inline for terminals that support the Kitty graphics protocol (Kitty, Ghostty, WezTerm) or iTerm2 inline images. Falls back to a text placeholder on unsupported terminals.

```typescript
interface ImageTheme {
  fallbackColor: (str: string) => string;
}

interface ImageOptions {
  maxWidthCells?: number;
  maxHeightCells?: number;
  filename?: string;
  viewportRows?: number;
}

const image = new Image(
  base64Data,       // base64-encoded image data
  "image/png",      // MIME type
  theme,            // ImageTheme
  options           // optional ImageOptions
);
tui.addChild(image);
```

Supported formats: PNG, JPEG, GIF, WebP. Dimensions are parsed from the image headers automatically.
When `viewportRows` is provided, the preview is limited to about one third of that height. Clicking its title expands it to about two thirds; `setExpanded()` and `setViewportRows()` also control those limits programmatically.

#### Alternate-screen image compatibility

`TuiAltScreen` supports inline images and partial viewport cropping in terminals that implement the Kitty graphics protocol, including Kitty and Ghostty. iTerm2's inline-image protocol does not provide operations to delete an existing placement or crop its source while scrolling. To prevent stale images from remaining over repainted content, `TuiAltScreen` renders image components as text placeholders in iTerm2. `TuiMainScreen` continues to render iTerm2 inline images normally.

## Autocomplete

### CombinedAutocompleteProvider

Completes file paths and file references. Command menus belong to the application using the editor.

```typescript
import { CombinedAutocompleteProvider } from "@candy/tui";

const provider = new CombinedAutocompleteProvider(
  process.cwd() // base path for file completion
);

editor.setAutocompleteProvider(provider);
```

**Features:**
- Press `Tab` for file path completion
- Works with `~/`, `./`, `../`, and `@` prefix
- Filters to attachable files for `@` prefix

## Key Detection

Use `matchesKey()` with the `Key` helper for detecting keyboard input (supports Kitty keyboard protocol):

```typescript
import { matchesKey, Key } from "@candy/tui";

if (matchesKey(data, Key.ctrl("c"))) {
  process.exit(0);
}

if (matchesKey(data, Key.enter)) {
  submit();
} else if (matchesKey(data, Key.escape)) {
  cancel();
} else if (matchesKey(data, Key.up)) {
  moveUp();
}
```

**Key identifiers** (use `Key.*` for autocomplete, or string literals):
- Basic keys: `Key.enter`, `Key.escape`, `Key.tab`, `Key.space`, `Key.backspace`, `Key.delete`, `Key.home`, `Key.end`
- Arrow keys: `Key.up`, `Key.down`, `Key.left`, `Key.right`
- With modifiers: `Key.ctrl("c")`, `Key.shift("tab")`, `Key.alt("left")`, `Key.ctrlShift("p")`
- String format also works: `"enter"`, `"ctrl+c"`, `"shift+tab"`, `"ctrl+shift+p"`
