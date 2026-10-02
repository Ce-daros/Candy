import {
	type Component,
	Container,
	moveSelection,
	Spacer,
	sliceByColumn,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@candy/tui";
import { APP_NAME, CONFIG_DIR_NAME } from "../../../config.ts";
import {
	getProjectTrustOptions,
	type ProjectTrustOption,
	type ProjectTrustStoreEntry,
} from "../../../core/trust-manager.ts";
import {
	dialogBody,
	dialogTitle,
	infoLine,
	metaSeparator,
	selectedRowLabel,
	selectionCursor,
	selectionMarkerSuffix,
	theme,
} from "../theme/theme.ts";
import { hintRow } from "./keybinding-hints.ts";
import { readListAction } from "./list-scaffold.ts";

export type TrustSelection = Pick<ProjectTrustOption, "trusted" | "updates">;

export interface TrustSelectorOptions {
	cwd: string;
	savedDecision: ProjectTrustStoreEntry | null;
	projectTrusted: boolean;
	includeSessionOnly?: boolean;
	onSelect: (selection: TrustSelection) => void;
	onCancel: () => void;
}

function pathText(prefix: string, path: string, suffix: string, style: (text: string) => string): Component {
	return {
		invalidate: () => {},
		render: (width) => {
			const available = Math.max(0, width - 2 - visibleWidth(prefix + suffix));
			const pathWidth = visibleWidth(path);
			const tailWidth = Math.max(0, available - 1);
			const fitted =
				pathWidth <= available ? path : `…${sliceByColumn(path, pathWidth - tailWidth, tailWidth, true)}`;
			return [truncateToWidth(` ${style(prefix + fitted + suffix)} `, width, "")];
		},
	};
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
		this.addChild(pathText("", options.cwd, "", (text) => theme.fg("muted", text)));
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
		const decision = options.savedDecision;
		if (decision === null) {
			this.addChild(new Text(infoLine("Saved decision", "none", "muted"), 1, 0));
		} else {
			const inherited = decision.path !== this.trustOptions[0]?.savedPath;
			const label = decision.decision ? "trusted" : "untrusted";
			this.addChild(
				pathText(
					`${theme.fg("muted", "Saved decision: ")}${label} (${inherited ? "inherited from " : ""}`,
					decision.path,
					")",
					(text) => theme.fg(decision.decision ? "success" : "error", text),
				),
			);
		}
		this.addChild(
			new Text(
				infoLine(
					"Current session",
					options.projectTrusted ? "trusted" : "untrusted",
					options.projectTrusted ? "success" : "error",
				),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				hintRow([
					{ raw: "↑↓", label: "navigate" },
					{ key: "tui.select.confirm", label: "save" },
					{ key: "tui.select.cancel", label: "cancel" },
				]),
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
			if (option.savedPath && option.label.includes(option.savedPath)) {
				const pathStart = option.label.indexOf(option.savedPath);
				this.listContainer.addChild(
					pathText(
						`${selectionCursor(isSelected)}${currentMarker}${option.label.slice(0, pathStart)}`,
						option.savedPath,
						`${option.label.slice(pathStart + option.savedPath.length)}${selectionMarkerSuffix(isSelected)}`,
						(text) => selectedRowLabel(text, isSelected),
					),
				);
			} else {
				this.listContainer.addChild(
					new Text(
						`${selectionCursor(isSelected)}${currentMarker}${label}${selectionMarkerSuffix(isSelected)}`,
						1,
						0,
					),
				);
			}
			const savedPaths = option.updates.filter((update) => update.decision !== null).map((update) => update.path);
			const detail =
				savedPaths.length === 0
					? `This session only${metaSeparator()}not saved`
					: `${savedPaths.join(", ")}${metaSeparator()}saved`;
			this.listContainer.addChild(
				savedPaths.length === 0
					? new Text(theme.fg("muted", `     ${detail}`), 1, 0)
					: pathText("     ", savedPaths.join(", "), `${metaSeparator()}saved`, (text) => theme.fg("muted", text)),
			);
		}
	}

	handleInput(keyData: string): void {
		switch (readListAction(keyData, { vim: true })) {
			case "up":
				this.selectedIndex = moveSelection(this.selectedIndex, this.trustOptions.length, -1);
				this.updateList();
				break;
			case "down":
				this.selectedIndex = moveSelection(this.selectedIndex, this.trustOptions.length, 1);
				this.updateList();
				break;
			case "confirm": {
				const selected = this.trustOptions[this.selectedIndex];
				if (selected) {
					this.onSelectCallback({ trusted: selected.trusted, updates: selected.updates });
				}
				break;
			}
			case "cancel":
				this.onCancelCallback();
				break;
		}
	}
}
