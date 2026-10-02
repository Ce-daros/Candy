import type { AuthEvent, AuthInfoLink } from "@candy/ai";
import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@candy/tui";
import { openBrowser } from "../../../utils/open-browser.ts";
import { dialogTitle, theme } from "../theme/theme.ts";
import { keycap, keyHint } from "./keybinding-hints.ts";

/**
 * Login dialog component - replaces editor during OAuth login flow
 */
export class LoginDialogComponent extends Container implements Focusable {
	private contentContainer: Container;
	private stageContainer: Container;
	private input: Input;
	private tui: TUI;
	private abortController = new AbortController();
	private inputResolver?: (value: string) => void;
	private inputRejecter?: (error: Error) => void;
	private onComplete: (success: boolean, message?: string) => void;
	private readonly titleText: Text;
	private readonly providerName: string;
	private waitingText?: Text;
	private progressText?: Text;
	private secretInput = false;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.inputResolver !== undefined;
	}

	constructor(
		tui: TUI,
		providerId: string,
		onComplete: (success: boolean, message?: string) => void,
		providerNameOverride?: string,
		titleOverride?: string,
	) {
		super();
		this.tui = tui;
		this.onComplete = onComplete;

		const providerName = providerNameOverride || providerId;
		this.providerName = providerName;
		const title = titleOverride ?? `Login to ${providerName}`;

		// Title
		this.titleText = new Text(dialogTitle(title), 1, 0);
		this.addChild(this.titleText);

		// Dynamic content area
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);
		this.stageContainer = new Container();
		this.addChild(this.stageContainer);

		// Input (always present, used when needed)
		this.input = new Input();
		this.input.onSubmit = () => {
			if (this.inputResolver) {
				const value = this.input.getValue();
				this.replaceInputWithSubmittedText(this.secretInput ? "••••••" : value);
				this.inputResolver(value);
				this.inputResolver = undefined;
				this.inputRejecter = undefined;
			}
		};
		this.input.onEscape = () => {
			this.cancel();
		};
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	private replaceInputWithSubmittedText(value: string): void {
		this.input.focused = false;
		this.stageContainer.children = this.stageContainer.children.map((child) =>
			child === this.input ? new Text(`> ${value}`, 0, 0) : child,
		);
	}

	private setPhase(phase: string): void {
		this.titleText.setText(theme.bold(theme.fg("accent", `${this.providerName} · ${phase}`)));
	}

	private cancel(): void {
		this.abort();
		this.onComplete(false, "Login cancelled");
	}

	abort(): void {
		this.abortController.abort();
		if (this.inputRejecter) {
			this.inputRejecter(new Error("Login cancelled"));
			this.inputResolver = undefined;
			this.inputRejecter = undefined;
		}
	}

	/**
	 * Called by onAuth callback - show URL and optional instructions
	 */
	showAuth(url: string, instructions?: string): void {
		this.setPhase("Authorize");
		this.contentContainer.clear();
		this.stageContainer.clear();
		this.waitingText = undefined;
		this.progressText = undefined;
		this.contentContainer.addChild(new Spacer(1));
		const linkedUrl = `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

		const clickHint = `${keycap(process.platform === "darwin" ? "Cmd+Click" : "Ctrl+Click")}${theme.fg("dim", " to open")}`;
		const hyperlink = `\x1b]8;;${url}\x07${clickHint}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(hyperlink, 1, 0));

		if (instructions) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("warning", instructions), 1, 0));
		}

		openBrowser(url);
		this.tui.requestRender();
	}

	showDeviceCode(info: Extract<AuthEvent, { type: "device_code" }>): void {
		this.setPhase("Device code");
		this.contentContainer.clear();
		this.stageContainer.clear();
		this.waitingText = undefined;
		this.progressText = undefined;
		this.contentContainer.addChild(new Spacer(1));
		const linkedUrl = `\x1b]8;;${info.verificationUri}\x07${info.verificationUri}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

		const clickHint = `${keycap(process.platform === "darwin" ? "Cmd+Click" : "Ctrl+Click")}${theme.fg("dim", " to open")}`;
		const hyperlink = `\x1b]8;;${info.verificationUri}\x07${clickHint}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(hyperlink, 1, 0));
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("warning", `Enter code: ${info.userCode}`), 1, 0));

		this.tui.requestRender();
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	showManualInput(prompt: string): Promise<string> {
		this.setPhase("Enter code");
		this.secretInput = false;
		this.input.setMasked(false);
		this.input.setValue("");
		this.waitingText = undefined;
		this.progressText = undefined;
		this.stageContainer.addChild(new Spacer(1));
		this.stageContainer.addChild(new Text(theme.fg("dim", prompt), 1, 0));
		this.stageContainer.addChild(this.input);
		this.stageContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
			this.input.focused = this._focused;
		});
	}

	/**
	 * Called by onPrompt callback - show prompt and wait for input
	 * Note: Does NOT clear content, appends to existing (preserves URL from showAuth)
	 */
	showPrompt(message: string, placeholder?: string, secret = false): Promise<string> {
		this.setPhase(secret ? "API key" : "Continue");
		this.secretInput = secret;
		this.input.setMasked(secret);
		this.waitingText = undefined;
		this.progressText = undefined;
		this.stageContainer.addChild(new Spacer(1));
		this.stageContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		if (placeholder) {
			this.stageContainer.addChild(new Text(theme.fg("dim", `e.g., ${placeholder}`), 1, 0));
		}
		this.stageContainer.addChild(this.input);
		this.stageContainer.addChild(
			new Text(
				`(${keyHint("tui.select.cancel", "to cancel,")} ${keyHint("tui.select.confirm", "to submit")})`,
				1,
				0,
			),
		);

		this.input.setValue("");
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
			this.input.focused = this._focused;
		});
	}

	/** Show informational text before another login step. */
	showDetails(lines: string[]): void {
		this.setPhase("Details");
		this.contentContainer.clear();
		this.stageContainer.clear();
		this.waitingText = undefined;
		this.progressText = undefined;
		this.contentContainer.addChild(new Spacer(1));
		for (const line of lines) {
			this.contentContainer.addChild(new Text(line, 1, 0));
		}
		this.tui.requestRender();
	}

	/** Show provider-owned information and links without starting an auth callback flow. */
	showInfo(message: string, links: readonly AuthInfoLink[] = [], showCloseHint = false): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		for (const link of links) {
			const text = link.label ? `${link.label}: ${link.url}` : link.url;
			const hyperlink = `\x1b]8;;${link.url}\x07${text}\x1b]8;;\x07`;
			this.contentContainer.addChild(new Text(theme.fg("accent", hyperlink), 1, 0));
		}
		if (showCloseHint) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to close")})`, 1, 0));
		}
		this.tui.requestRender();
	}

	/**
	 * Show waiting message (for polling flows like GitHub Copilot)
	 */
	showWaiting(message: string): void {
		this.input.focused = false;
		this.setPhase("Waiting");
		if (this.waitingText) this.waitingText.setText(theme.fg("dim", message));
		else {
			this.stageContainer.clear();
			this.progressText = undefined;
			this.stageContainer.addChild(new Spacer(1));
			this.waitingText = new Text(theme.fg("dim", message), 1, 0);
			this.stageContainer.addChild(this.waitingText);
			this.stageContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		}
		this.tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	showProgress(message: string): void {
		if (this.progressText) this.progressText.setText(theme.fg("dim", message));
		else {
			this.progressText = new Text(theme.fg("dim", message), 1, 0);
			this.stageContainer.addChild(this.progressText);
		}
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		// Pass to input
		if (this.inputResolver) this.input.handleInput(data);
	}
}
