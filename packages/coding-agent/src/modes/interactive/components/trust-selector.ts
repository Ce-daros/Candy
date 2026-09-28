import { Container, getKeybindings, Spacer, Text } from "@candy/tui";
import { APP_NAME, CONFIG_DIR_NAME } from "../../../config.ts";
import {
	getProjectTrustOptions,
	type ProjectTrustOption,
	type ProjectTrustStoreEntry,
} from "../../../core/trust-manager.ts";
import {
	dialogBody,
	dialogTitle,
	selectedRowLabel,
	selectionCursor,
	selectionMarkerSuffix,
	theme,
} from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export type TrustSelection = Pick<ProjectTrustOption, "trusted" | "updates">;

export interface TrustSelectorOptions {
	cwd: string;
	savedDecision: ProjectTrustStoreEntry | null;
	projectTrusted: boolean;
	includeSessionOnly?: boolean;
	onSelect: (selection: TrustSelection) => void;
	onCancel: () => void;
}

function formatDecision(trustPath: string | undefined, decision: ProjectTrustStoreEntry | null): string {
	if (decision === null) {
		return "none";
	}
	const label = decision.decision ? "trusted" : "untrusted";
	if (trustPath !== undefined && decision.path !== trustPath) {
		return `${label} (inherited from ${decision.path})`;
	}
	return `${label} (${decision.path})`;
}

export class TrustSelectorComponent extends Container {
	private selectedIndex: number;
	private readonly listContainer: Container;
	private readonly trustOptions: ProjectTrustOption[];
	private readonly savedDecision: ProjectTrustStoreEntry | null;
	private readonly onSelectCallback: (selection: TrustSelection) => void;
	private readonly onCancelCallback: () => void;

	constructor(options: TrustSelectorOptions) {
		super();

		this.savedDecision = options.savedDecision;
		this.trustOptions = getProjectTrustOptions(options.cwd, {
			includeSessionOnly: options.includeSessionOnly ?? true,
		});
		this.selectedIndex = Math.max(
			0,
			this.trustOptions.findIndex((option) => this.isSavedOption(option)),
		);
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;

		this.addChild(new Text(dialogTitle("Project trust"), 1, 0));
		this.addChild(new Text(theme.fg("muted", options.cwd), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				dialogBody(
					`This allows ${APP_NAME} to load ${CONFIG_DIR_NAME} settings and resources, install missing project packages, and execute project extensions.`,
				),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					`Saved decision: ${formatDecision(this.trustOptions[0]?.savedPath, options.savedDecision)}`,
				),
				1,
				0,
			),
		);
		this.addChild(
			new Text(theme.fg("muted", `Current session: ${options.projectTrusted ? "trusted" : "untrusted"}`), 1, 0),
		);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "save") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.updateList();
	}

	private isSavedOption(option: ProjectTrustOption): boolean {
		return (
			option.savedPath !== undefined &&
			this.savedDecision?.decision === option.trusted &&
			this.savedDecision.path === option.savedPath
		);
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.trustOptions.length; i++) {
			const option = this.trustOptions[i];
			if (!option) {
				continue;
			}

			const isSelected = i === this.selectedIndex;
			const isCurrent = this.isSavedOption(option);
			const currentMarker = isCurrent ? theme.fg("accent", "✓ ") : "  ";
			const label = selectedRowLabel(option.label, isSelected);
			this.listContainer.addChild(
				new Text(
					`${selectionCursor(isSelected)}${currentMarker}${label}${selectionMarkerSuffix(isSelected)}`,
					1,
					0,
				),
			);
			const savedPaths = option.updates.filter((update) => update.decision !== null).map((update) => update.path);
			const detail = savedPaths.length === 0 ? "This session only · not saved" : `${savedPaths.join(", ")} · saved`;
			this.listContainer.addChild(new Text(theme.fg("muted", `     ${detail}`), 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.trustOptions.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.trustOptions[this.selectedIndex];
			if (selected) {
				this.onSelectCallback({ trusted: selected.trusted, updates: selected.updates });
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}
}
