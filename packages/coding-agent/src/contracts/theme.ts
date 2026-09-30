import type { ThinkingLevel } from "@candy/agent-core";
import type { Color, TerminalColorMode, TextAttributes } from "@candy/tui";
import type { SourceInfo } from "../core/source-info.ts";
export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "scrollbarTrack"
	| "scrollbarThumb"
	| "searchMatchText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "thinkingMax"
	| "bashMode"
	| "editorPrompt";

export type ThemeBg =
	| "selectedBg"
	| "searchMatchBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg";

export type ThemeToken = ThemeColor | ThemeBg;

/**
 * Tokens are only accepted in their own slot, because "" (terminal default) means the default foreground
 * or background depending on the slot. Use `theme.colors[token]` to use a token's color in the other slot.
 */
export interface ThemeStyle extends TextAttributes {
	fg?: ThemeColor | Color;
	bg?: ThemeBg | Color;
}

export type ThemeAppearance = "dark" | "light";
export interface Theme {
	readonly name?: string;
	readonly sourcePath?: string;
	sourceInfo?: SourceInfo;
	readonly appearance: ThemeAppearance;
	readonly colors: Readonly<Record<ThemeToken, Color>>;
	style(text: string, options: ThemeStyle): string;
	fg(color: ThemeColor, text: string): string;
	bg(color: ThemeBg, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
	underline(text: string): string;
	inverse(text: string): string;
	strikethrough(text: string): string;
	getFgAnsi(color: ThemeColor): string;
	getBgAnsi(color: ThemeBg): string;
	getColorMode(): TerminalColorMode;
	getThinkingBorderColor(level: ThinkingLevel): (text: string) => string;
	getBashModeBorderColor(): (text: string) => string;
}
