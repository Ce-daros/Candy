import type { Api, Model } from "@candy/ai";
import type { AutocompleteItem } from "@candy/tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { CommandPanel, type CommandPanelAction, type CommandPanelOptions } from "./components/command-panel.ts";
import type { PanelNavigation } from "./components/panel-transition.ts";
import { type InteractiveFlowFrame, InteractiveFlowStack } from "./interactive-flow-stack.ts";
import {
	ActionsController,
	CommandController,
	DetailsController,
	SourcesController,
} from "./interactive-presentation-features.ts";

export type PresentationSurface = "actions" | "sources" | "details" | "command";

export interface PresentationHost {
	session(): AgentSession;
	models(): ModelRuntime;
	settings(): SettingsManager;
	mount(panel: CommandPanel, navigation: PanelNavigation): void;
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
	sessionCommands(): CommandPanelAction[];
	completeArguments?(text: string, signal: AbortSignal, force?: boolean): Promise<AutocompleteItem[] | null>;
	sessionAction(
		action: "compact" | "details" | "rename" | "tree" | "fork" | "clone" | "resume",
		args: string,
	): Promise<void>;
}

export interface PresentationPage extends InteractiveFlowFrame {
	role: "presentation";
	kind: PresentationSurface;
	panel: CommandPanel;
	session: AgentSession;
	scopeChanged: boolean;
	closing: boolean;
	refresh: () => void;
}

export class InteractivePresentation {
	private readonly host: PresentationHost;
	private readonly flows: InteractiveFlowStack;
	private readonly sources: SourcesController;
	private readonly details: DetailsController;
	private readonly actions: ActionsController;
	private readonly command: CommandController;

	constructor(host: PresentationHost, flows: InteractiveFlowStack = new InteractiveFlowStack()) {
		this.host = host;
		this.flows = flows;
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
		this.actions = new ActionsController(
			host,
			page,
			refresh,
			() => this.sources.openSources(),
			(model) => this.details.openDetails(model),
		);
		this.command = new CommandController(
			host,
			page,
			refresh,
			(target) => this.isCurrentPage(target),
			() => this.finish(),
		);
	}

	get active(): boolean {
		return this.flows.last("presentation") !== undefined;
	}

	get surface(): PresentationSurface | undefined {
		return this.flows.last("presentation")?.kind as PresentationSurface | undefined;
	}

	open(surface: PresentationSurface, model?: Model<Api>): void {
		this.dispose();
		switch (surface) {
			case "sources":
				this.sources.openSources();
				break;
			case "details":
				if (model) this.details.openDetails(model);
				break;
			case "actions":
				this.actions.openActions();
				break;
			case "command":
				this.command.openCommand();
				break;
		}
	}

	resume(): boolean {
		const page = this.flows.last("presentation") as PresentationPage | undefined;
		if (!page || this.flows.current !== page || page.session !== this.host.session()) return false;
		page.refresh();
		page.panel.resume();
		this.host.mount(page.panel, "back");
		return true;
	}

	finish(): void {
		this.dispose();
		this.host.exit();
	}

	dispose(): void {
		this.flows.clear();
	}

	private back(): void {
		const page = this.flows.current as PresentationPage | undefined;
		if (!page || page.role !== "presentation" || page.closing) return;
		if (page.kind === "sources" && this.flows.parentOf(page)?.kind !== "sources" && page.scopeChanged) {
			page.closing = true;
			page.panel.suspend();
			void this.host.applyQuickSelection(page.controller.signal).then(
				() => {
					if (!this.isLive(page)) return;
					this.closePage(page);
				},
				(error: unknown) => {
					if (!this.isLive(page)) return;
					page.closing = false;
					page.panel.resume();
					this.host.mount(page.panel, "replace");
					this.host.reportError(error instanceof Error ? error.message : String(error));
				},
			);
			return;
		}
		this.closePage(page);
	}

	private closePage(page: PresentationPage): void {
		this.flows.pop(page);
		if (!this.flows.last("presentation")) this.finish();
	}

	private page(
		kind: PresentationSurface,
		title: string,
		getActions: (page: PresentationPage) => CommandPanelAction[],
		getDescription: () => string = () => "",
		onSelectionChange?: CommandPanelOptions["onSelectionChange"],
		searchable = kind === "command" || kind === "sources",
	): PresentationPage {
		const panel = new CommandPanel([], {
			title,
			onCancel: () => this.back(),
			onMessage: () => this.finish(),
			requestRender: () => this.host.render(),
			onSelectionChange,
			searchable,
		});
		let page: PresentationPage;
		page = this.flows.push({
			role: "presentation",
			kind,
			panel,
			content: panel,
			session: this.host.session(),
			scopeChanged: false,
			closing: false,
			refresh: () => {
				panel.setActions(getActions(page));
				panel.setDescription(getDescription());
			},
			onSuspend: () => panel.suspend(),
			onResume: () => {
				if (!this.isLive(page)) return;
				page.refresh();
				panel.resume();
				this.host.mount(panel, "back");
			},
			dispose: () => panel.dispose(),
		}) as PresentationPage;
		page.refresh();
		this.host.mount(panel, "enter");
		return page;
	}

	private refresh(page: PresentationPage): void {
		if (this.flows.last("presentation") !== page || !this.isLive(page)) return;
		page.refresh();
		this.host.render();
	}

	private assertScopeEditable(): void {
		const session = this.host.session();
		if (session.execution.isStreaming || session.execution.isCompacting)
			throw new Error("Wait for the current response or compaction to finish");
	}

	private markScopeChanged(): void {
		const sourcePage = this.flows.all.find(
			(frame): frame is PresentationPage => frame.role === "presentation" && frame.kind === "sources",
		);
		if (sourcePage) sourcePage.scopeChanged = true;
	}

	private isCurrentPage(page: PresentationPage): boolean {
		return this.flows.has(page) && this.isLive(page);
	}

	private isLive(page: PresentationPage): boolean {
		return !page.controller.signal.aborted && page.session === this.host.session();
	}
}
