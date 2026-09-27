import type { ThinkingLevel } from "@candy/agent-core";
import { Editor, type EditorOptions, type EditorTheme, type TUI, visibleWidth } from "@candy/tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import type { AnimationIntensity } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { FrameMotion, type ShellMode } from "./frame-motion.ts";
import type { StatusIndicator } from "./status-indicator.ts";

export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
};

/**
 * Status line merged into the editor's bottom border.
 * The implementation owns the segment layout; the editor owns the frame width and border color.
 */
export interface EditorBottomStatus {
	renderBottomBorder(width: number, hiddenLineCount: number, borderColor: (text: string) => string): string;
	setFrameMotion?(motion: FrameMotion): void;
	getBorderAnchors?(width: number): { left: number; right: number };
}

/** Default left gutter so the input area reads as one frame with the bottom border. */
const DEFAULT_LEFT_GUTTER = "│  ";
/** Prompt glyph on the first input line: a diamond in normal mode. */
const PROMPT_GLYPH_NORMAL = "◆";
/** Prompt glyph on the first input line: a chevron in Shell modes. */
const PROMPT_GLYPH_SHELL = "❯";
/** Gutter on the first input line: border, prompt glyph, then one column before the text. */
const PROMPT_LEFT_GUTTER_NORMAL = `│${PROMPT_GLYPH_NORMAL} `;
const PROMPT_LEFT_GUTTER_SHELL = `│${PROMPT_GLYPH_SHELL} `;

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private bottomStatus: EditorBottomStatus | undefined;
	private readonly frameMotion: FrameMotion;
	public readonly embedWorkingStatus: boolean;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	/**
	 * Input handler for the inline Powerbar selectors in the bottom border.
	 * Called before all other handling; returns true when the key was consumed.
	 */
	public powerbarHandler?: (data: string) => boolean;
	public shellInputHandler?: (data: string) => boolean;
	/** Left click on the bottom border row (Powerbar labels). Returns true when handled. */
	public onBottomBorderClick?: (x: number) => boolean;

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, {
			leftGutter: DEFAULT_LEFT_GUTTER,
			firstLineGutter: PROMPT_LEFT_GUTTER_NORMAL,
			rightGutter: "│",
			minContentLines: 2,
			...options,
		});
		this.keybindings = keybindings;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
		this.frameMotion = new FrameMotion(tui);
		this.bottomBorderClick = (x) => this.onBottomBorderClick?.(x) ?? false;
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		indicator?.stop();
		this.frameMotion.setStatus(indicator?.kind);
	}

	setBottomStatus(status: EditorBottomStatus | undefined): void {
		this.bottomStatus = status;
		status?.setFrameMotion?.(this.frameMotion);
	}

	setShellMode(mode: ShellMode): void {
		this.frameMotion.setMode(mode);
		this.setFirstLineGutter(mode === "normal" ? PROMPT_LEFT_GUTTER_NORMAL : PROMPT_LEFT_GUTTER_SHELL);
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.frameMotion.setThinking(level);
	}

	setAnimationOptions(enabled: boolean, intensity: AnimationIntensity): void {
		this.frameMotion.setOptions(enabled, intensity);
	}

	restartEntranceAnimation(): void {
		this.frameMotion.restartEntrance();
	}

	dispose(): void {
		this.frameMotion.dispose();
	}

	override render(width: number): string[] {
		const anchors = this.bottomStatus?.getBorderAnchors?.(width) ?? { left: 4, right: Math.max(4, width - 5) };
		this.frameMotion.setGeometry(width, this.getFrameRowCount(), anchors.left, anchors.right);
		return super.render(width);
	}

	protected override colorSideBorder(text: string, side: "left" | "right", row: number, _totalRows: number): string {
		if (side === "left") {
			const mode = this.frameMotion.getMode();
			const glyph = mode === "normal" ? PROMPT_GLYPH_NORMAL : PROMPT_GLYPH_SHELL;
			const index = text.indexOf(glyph);
			if (index !== -1) {
				// The border cell keeps the animated frame color; only the prompt glyph takes its own color.
				const before = text.slice(0, index);
				const after = text.slice(index + glyph.length);
				return (
					this.frameMotion.paintBorder(before, 0, row) +
					theme.fg(mode === "normal" ? "editorPrompt" : "bashMode", glyph) +
					(after ? this.frameMotion.paintBorder(after, index + glyph.length, row) : "")
				);
			}
		}
		return this.frameMotion.paintBorder(text, side === "left" ? 0 : this.frameWidth - 1, row);
	}

	private frameWidth = 80;

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		this.frameWidth = width;
		if (!this.bottomStatus || width <= 0) {
			if (width < 2) return super.renderBottomBorder(width, hiddenLineCount);
			return this.frameMotion.paintBorder(`╰${"─".repeat(width - 2)}╯`, 0, this.getFrameRowCount() - 1);
		}
		return this.bottomStatus.renderBottomBorder(width, hiddenLineCount, this.borderColor);
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		this.frameWidth = width;
		const anchors = this.bottomStatus?.getBorderAnchors?.(width) ?? { left: 4, right: Math.max(4, width - 5) };
		this.frameMotion.setGeometry(width, this.getFrameRowCount(), anchors.left, anchors.right);
		this.frameMotion.beginFrame();
		if (width < 2) return this.frameMotion.paintBorder("─".repeat(Math.max(0, width)), 0, 0);
		const line = `╭${"─".repeat(width - 2)}╮`;
		const status =
			!this.frameMotion.isEnabled() && this.embedWorkingStatus ? this.frameMotion.getStatus() : undefined;
		const statusWord =
			status === "working"
				? "Working"
				: status === "retry"
					? "Retrying"
					: status === "compaction"
						? "Compacting"
						: status === "branchSummary"
							? "Summarizing"
							: "";
		const shellTitle = this.frameMotion.getShellTitle();
		// Shell titles get one half-width space of padding on each side.
		const title = shellTitle ? ` ${[shellTitle, statusWord].filter(Boolean).join(" · ")} ` : statusWord;
		const titleStart = 7;
		const titleWidth = Math.min(visibleWidth(title), Math.max(0, width - titleStart - 2));
		const displayedTitle = title.slice(0, titleWidth);
		const overflow = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : "";
		const overflowStart = Math.floor((width - visibleWidth(overflow)) / 2);
		const showOverflow =
			overflow && overflowStart > titleStart + titleWidth + 1 && overflowStart + visibleWidth(overflow) < width - 1;
		let output = "";
		let column = 0;
		for (const [start, content] of [
			[titleStart, displayedTitle],
			[overflowStart, showOverflow ? overflow : ""],
		] as const) {
			if (!content || start < column) continue;
			output += this.frameMotion.paintBorder(line.slice(column, start), column, 0);
			output += start === titleStart ? this.frameMotion.paintTitle(content) : content;
			column = start + visibleWidth(content);
		}
		output += this.frameMotion.paintBorder(line.slice(column), column, 0);
		return output;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Inline Powerbar selectors take precedence; escape confirms/cancels there
		// instead of interrupting the agent.
		if (this.powerbarHandler?.(data)) {
			return;
		}
		if (this.shellInputHandler?.(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
