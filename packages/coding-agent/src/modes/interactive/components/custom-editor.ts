import { Editor, type EditorOptions, type EditorTheme, type TUI, visibleWidth } from "@candy/tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
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
}

/** Default left gutter so the input area reads as one frame with the bottom border. */
const DEFAULT_LEFT_GUTTER = "│ ";

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
	private bottomStatus: EditorBottomStatus | undefined;
	public readonly embedWorkingStatus: boolean;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, { leftGutter: DEFAULT_LEFT_GUTTER, rightGutter: "│", minContentLines: 2, ...options });
		this.keybindings = keybindings;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	setBottomStatus(status: EditorBottomStatus | undefined): void {
		this.bottomStatus = status;
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (!this.bottomStatus || width <= 0) {
			if (width < 2) return super.renderBottomBorder(width, hiddenLineCount);
			return this.borderColor("╰") + super.renderBottomBorder(width - 2, hiddenLineCount) + this.borderColor("╯");
		}
		return this.bottomStatus.renderBottomBorder(width, hiddenLineCount, this.borderColor);
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (width < 2) return this.borderColor("─".repeat(Math.max(0, width)));
		const innerWidth = width - 2;
		if (!this.embedWorkingStatus || !this.workingStatusIndicator) {
			return this.borderColor("╭") + super.renderTopBorder(innerWidth, hiddenLineCount) + this.borderColor("╮");
		}

		let status = this.workingStatusIndicator.renderInBorder(Math.max(1, innerWidth - 5));
		let statusWidth = visibleWidth(status);
		if (statusWidth === 0) {
			return this.borderColor("╭") + super.renderTopBorder(innerWidth, hiddenLineCount) + this.borderColor("╮");
		}

		const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
		const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
		const overflowStart = Math.floor((innerWidth - overflowLabelWidth) / 2);
		const canFitOverflow = () =>
			overflowLabel !== undefined &&
			overflowLabelWidth + 2 <= innerWidth &&
			overflowStart - (3 + statusWidth + 1) >= 1;

		if (overflowLabel && !canFitOverflow()) {
			status = this.workingStatusIndicator.renderSpinnerInBorder(innerWidth);
			statusWidth = visibleWidth(status);
		}

		let inner: string;
		if (canFitOverflow()) {
			const leftBlockWidth = 3 + statusWidth + 1;
			inner =
				this.borderColor("── ") +
				status +
				this.borderColor(
					` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(innerWidth - overflowStart - overflowLabelWidth)}`,
				);
		} else if (innerWidth >= statusWidth + 5) {
			inner = this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(innerWidth - statusWidth - 4)}`);
		} else {
			status = this.workingStatusIndicator.renderSpinnerInBorder(innerWidth);
			statusWidth = visibleWidth(status);
			const prefixWidth = Math.min(3, Math.max(0, innerWidth - statusWidth));
			inner =
				this.borderColor("─".repeat(prefixWidth)) +
				status +
				this.borderColor("─".repeat(Math.max(0, innerWidth - prefixWidth - statusWidth)));
		}
		return this.borderColor("╭") + inner + this.borderColor("╮");
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
