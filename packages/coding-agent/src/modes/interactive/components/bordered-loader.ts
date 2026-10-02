import { CancellableLoader, Container, Loader, Spacer, Text, type TUI } from "@candy/tui";
import type { Theme } from "../../../contracts/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

/** Loader wrapped with borders for extension UI */
export class BorderedLoader extends Container {
	private readonly loader: Loader;
	private readonly cancellableLoader?: CancellableLoader;
	readonly signal: AbortSignal;

	constructor(tui: TUI, theme: Pick<Theme, "fg">, message: string, options?: { cancellable?: boolean }) {
		super();
		const cancellable = options?.cancellable ?? true;
		if (cancellable) {
			const loader = new CancellableLoader(
				tui,
				(s) => theme.fg("accent", s),
				(s) => theme.fg("muted", s),
				message,
			);
			this.loader = loader;
			this.cancellableLoader = loader;
			this.signal = loader.signal;
		} else {
			this.signal = new AbortController().signal;
			this.loader = new Loader(
				tui,
				(s) => theme.fg("accent", s),
				(s) => theme.fg("muted", s),
				message,
			);
		}
		this.addChild(this.loader);
		if (cancellable) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(keyHint("tui.select.cancel", "cancel"), 1, 0));
		}
	}

	set onAbort(fn: (() => void) | undefined) {
		if (this.cancellableLoader) {
			this.cancellableLoader.onAbort = fn;
		}
	}

	handleInput(data: string): void {
		this.cancellableLoader?.handleInput(data);
	}

	dispose(): void {
		this.loader.stop();
	}
}
