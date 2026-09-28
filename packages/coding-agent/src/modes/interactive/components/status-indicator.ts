import { type Component, Loader, type TUI, truncateToWidth } from "@candy/tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { keyHint } from "./keybinding-hints.ts";

export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";

export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
	) {
		super(ui, spinnerColorFn, messageColorFn, message);
		this.kind = kind;
	}

	renderInBorder(width: number): string {
		const line = super.render(width + 2)[1] ?? "";
		return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
	}

	renderSpinnerInBorder(width: number): string {
		return truncateToWidth(this.getRenderedIndicator(), width, "");
	}

	dispose(): void {
		this.stop();
	}
}

export class WorkingStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, message: string, colorFn?: (text: string) => string) {
		super(
			"working",
			ui,
			colorFn ?? ((text) => theme.fg("accent", text)),
			colorFn ?? ((text) => theme.fg("muted", text)),
			message,
		);
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;

	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number) {
		const retryMessage = (seconds: number) =>
			`${theme.fg("muted", `Retrying (${attempt}/${maxAttempts}) in ${seconds}s... (`)}${keyHint("app.interrupt", "to cancel")}${theme.fg("muted", ")")}`;
		super(
			"retry",
			ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => text,
			retryMessage(Math.ceil(delayMs / 1000)),
		);
		this.countdown = new CountdownTimer(
			delayMs,
			ui,
			(seconds) => {
				this.setMessage(retryMessage(seconds));
			},
			() => {
				this.countdown = undefined;
			},
		);
	}

	override dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
		super.dispose();
	}
}

export type CompactionStatusReason = "manual" | "threshold" | "overflow";

export class CompactionStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, reason: CompactionStatusReason) {
		const cancelHint = `${theme.fg("muted", "(")}${keyHint("app.interrupt", "to cancel")}${theme.fg("muted", ")")}`;
		const label =
			reason === "manual"
				? `${theme.fg("muted", "Compacting context... ")}${cancelHint}`
				: `${theme.fg("muted", `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... `)}${cancelHint}`;
		super(
			"compaction",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => text,
			label,
		);
	}
}

export class BranchSummaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI) {
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => text,
			`${theme.fg("muted", "Summarizing branch... (")}${keyHint("app.interrupt", "to cancel")}${theme.fg("muted", ")")}`,
		);
	}
}

export class IdleStatus implements Component {
	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}
}
