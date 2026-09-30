import type { Api, Model } from "@candy/ai";
import type { AutocompleteItem } from "@candy/tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { CommandPanel, type CommandPanelAction, type CommandPanelOptions } from "./components/command-panel.ts";
import {
	AgentController,
	CommandController,
	DetailsController,
	HistoryController,
	SourcesController,
} from "./interactive-presentation-features.ts";

export type PresentationSurface = "sources" | "details" | "history" | "agent" | "command";

export interface PresentationHost {
	session(): AgentSession;
	settings(): SettingsManager;
	mount(panel: CommandPanel): void;
	exit(): void;
	render(): void;
	read(title: string, content: string, onEdit?: () => Promise<string | undefined>): void;
	reportError(message: string): void;
	applyQuickSelection(signal: AbortSignal): Promise<void>;
	edit(title: string, content: string): Promise<string | undefined>;
	login(provider: string): Promise<void>;
	skills(): Promise<void>;
	settingsActions(): CommandPanelAction[];
	localCommands(): CommandPanelAction[];
	historyCommands(): CommandPanelAction[];
	completeArguments?(text: string, signal: AbortSignal, force?: boolean): Promise<AutocompleteItem[] | null>;
	historyAction(
		action: "compact" | "details" | "rename" | "tree" | "fork" | "clone" | "resume",
		args: string,
	): Promise<void>;
}

export interface PresentationPage {
	kind: PresentationSurface;
	panel: CommandPanel;
	refresh: () => void;
	controller: AbortController;
}

export class InteractivePresentation {
	private readonly host: PresentationHost;
	private pages: PresentationPage[] = [];
	private session: AgentSession | undefined;
	private scopeChanged = false;
	private closing = false;
	private readonly sources: SourcesController;
	private readonly details: DetailsController;
	private readonly history: HistoryController;
	private readonly agent: AgentController;
	private readonly command: CommandController;

	constructor(host: PresentationHost) {
		this.host = host;
		const page = (...args: Parameters<InteractivePresentation["page"]>) => this.page(...args);
		const refresh = (target: PresentationPage) => this.refresh(target);
		this.sources = new SourcesController(
			host,
			page,
			refresh,
			() => this.markScopeChanged(),
			() => this.assertScopeEditable(),
		);
		this.details = new DetailsController(host, page, refresh);
		this.history = new HistoryController(host, page, refresh);
		this.agent = new AgentController(host, page, refresh);
		this.command = new CommandController(
			host,
			page,
			refresh,
			(target) => this.isCurrentPage(target),
			() => this.finish(),
		);
	}

	get active(): boolean {
		return this.pages.length > 0;
	}

	get surface(): PresentationSurface | undefined {
		return this.pages[0]?.kind;
	}

	open(surface: PresentationSurface, model?: Model<Api>): void {
		this.dispose();
		this.session = this.host.session();
		switch (surface) {
			case "sources":
				this.sources.openSources();
				break;
			case "details":
				if (model) this.details.openDetails(model);
				break;
			case "history":
				this.history.openHistory();
				break;
			case "agent":
				this.agent.openAgent();
				break;
			case "command":
				this.command.openCommand();
				break;
		}
	}

	resume(): boolean {
		const page = this.pages.at(-1);
		if (!page || this.session !== this.host.session()) return false;
		page.refresh();
		page.panel.resume();
		this.host.mount(page.panel);
		return true;
	}

	suspendFor(content: object): void {
		const page = this.pages.at(-1);
		if (page && page.panel !== content) page.panel.suspend();
	}

	finish(): void {
		this.dispose();
		this.host.exit();
	}

	dispose(): void {
		for (const page of this.pages) {
			page.controller.abort();
			page.panel.dispose();
		}
		this.pages = [];
		this.session = undefined;
		this.scopeChanged = false;
		this.closing = false;
	}

	private back(): void {
		if (this.closing) return;
		if (this.pages.length === 1 && this.scopeChanged) {
			const page = this.pages[0];
			this.closing = true;
			page.panel.suspend();
			void this.host.applyQuickSelection(page.controller.signal).then(
				() => {
					if (page.controller.signal.aborted || this.session !== this.host.session()) return;
					this.finish();
				},
				(error: unknown) => {
					if (page.controller.signal.aborted || this.session !== this.host.session()) return;
					this.closing = false;
					page.panel.resume();
					this.host.mount(page.panel);
					this.host.reportError(error instanceof Error ? error.message : String(error));
				},
			);
			return;
		}
		const page = this.pages.pop();
		page?.controller.abort();
		page?.panel.dispose();
		if (!this.resume()) this.finish();
	}

	private page(
		kind: PresentationSurface,
		title: string,
		getActions: (page: PresentationPage) => CommandPanelAction[],
		getDescription: () => string = () => "",
		onSelectionChange?: CommandPanelOptions["onSelectionChange"],
		searchable = kind === "command" || kind === "sources",
	): PresentationPage {
		this.pages.at(-1)?.panel.suspend();
		const panel = new CommandPanel([], {
			title,
			onCancel: () => this.back(),
			onMessage: () => this.finish(),
			requestRender: () => this.host.render(),
			onSelectionChange,
			searchable,
		});
		const page: PresentationPage = {
			kind,
			panel,
			controller: new AbortController(),
			refresh: () => {
				panel.setActions(getActions(page));
				panel.setDescription(getDescription());
			},
		};
		this.pages.push(page);
		page.refresh();
		this.host.mount(panel);
		return page;
	}

	private refresh(page: PresentationPage): void {
		if (this.pages.at(-1) !== page || this.session !== this.host.session()) return;
		page.refresh();
		this.host.render();
	}

	private assertScopeEditable(): void {
		const session = this.host.session();
		if (session.isStreaming || session.isCompacting)
			throw new Error("Wait for the current response or compaction to finish");
	}

	private markScopeChanged(): void {
		this.scopeChanged = true;
	}

	private isCurrentPage(page: PresentationPage): boolean {
		return this.pages.at(-1) === page && this.session === this.host.session();
	}
}
