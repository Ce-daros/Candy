import {
	type Component,
	getKeybindings,
	moveSelection,
	moveViewport,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@candy/tui";
import { selectedRowLabel, selectionCursor, selectionMarkerSuffix, theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

interface UserMessageItem {
	id: string;
	text: string;
	timestamp?: string;
}

class UserMessageList implements Component {
	private readonly messages: UserMessageItem[];
	private selectedIndex: number;
	private availableHeight = 20;
	private previewOffset = 0;
	private previewLineCount = 0;
	private previewHeight = 0;
	private region: "list" | "preview" = "list";
	private visibleStart = 0;
	private visibleCount = 0;
	private previewStart = 0;
	onSelect?: (entryId: string) => void;
	onCancel?: () => void;

	constructor(messages: UserMessageItem[], initialSelectedId?: string) {
		this.messages = messages;
		const index = initialSelectedId ? messages.findIndex((message) => message.id === initialSelectedId) : -1;
		this.selectedIndex = index >= 0 ? index : Math.max(0, messages.length - 1);
	}

	setAvailableHeight(height: number): void {
		this.availableHeight = Math.max(8, height);
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.messages.length === 0) return [theme.fg("muted", "No user messages found")];
		const previewHeight = Math.max(2, Math.min(8, Math.floor(this.availableHeight / 3)));
		const listHeight = this.availableHeight - previewHeight - 4;
		const visibleCount = Math.max(1, Math.floor(listHeight / 2));
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(visibleCount / 2), this.messages.length - visibleCount),
		);
		this.visibleStart = start;
		this.visibleCount = visibleCount;
		const lines: string[] = [];
		for (let i = start; i < Math.min(start + visibleCount, this.messages.length); i++) {
			const message = this.messages[i];
			const selected = i === this.selectedIndex;
			const summary = wrapTextWithAnsi(message.text.replace(/\s+/g, " ").trim(), Math.max(10, width - 7)).slice(
				0,
				2,
			);
			const first = selected
				? `${selectionCursor(true)}${selectedRowLabel(summary[0] ?? "", true)}${selectionMarkerSuffix(true)}`
				: `${selectionCursor(false)}${selectedRowLabel(summary[0] ?? "", false)}`;
			lines.push(truncateToWidth(first, width));
			lines.push(
				truncateToWidth(
					theme.fg("muted", `  ${summary[1] ?? `Message ${i + 1} of ${this.messages.length}`}`),
					width,
				),
			);
		}
		while (lines.length < listHeight) lines.push("");
		lines.push(theme.fg("borderMuted", "─".repeat(width)));
		const current = this.messages[this.selectedIndex];
		lines.push(theme.bold(theme.fg("accent", `Message ${this.selectedIndex + 1} of ${this.messages.length}`)));
		const preview = wrapTextWithAnsi(current.text, Math.max(10, width - 2));
		this.previewStart = lines.length;
		this.previewLineCount = preview.length;
		this.previewHeight = previewHeight;
		for (const line of preview.slice(this.previewOffset, this.previewOffset + previewHeight)) {
			lines.push(`  ${truncateToWidth(line, width - 2)}`);
		}
		while (lines.length < this.previewStart + previewHeight) lines.push("");
		lines.push(
			preview.length > previewHeight
				? theme.fg(
						"muted",
						`  ${this.previewOffset + 1}–${Math.min(preview.length, this.previewOffset + previewHeight)} / ${preview.length}`,
					)
				: "",
		);
		lines.push(
			`${keyHint("app.panel.focusNext", "list / preview")} · ${keyHint("tui.select.confirm", "fork")} · ${keyHint("tui.select.cancel", "close")}`,
		);
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			const delta = event.wheelDelta < 0 ? 1 : -1;
			if (this.region === "preview")
				this.previewOffset = moveViewport(this.previewOffset, this.previewLineCount, this.previewHeight, delta);
			else {
				const selectedIndex = moveSelection(this.selectedIndex, this.messages.length, delta);
				if (selectedIndex !== this.selectedIndex) this.previewOffset = 0;
				this.selectedIndex = selectedIndex;
			}
			return { handled: true, render: true };
		}
		if (event.type === "click" && event.button === "left" && event.y >= 0 && event.y < this.visibleCount * 2) {
			this.selectedIndex = this.visibleStart + Math.floor(event.y / 2);
			this.previewOffset = 0;
			this.region = "list";
			return { handled: true, render: true };
		}
		if (event.type === "click" && event.button === "left" && event.y >= this.previewStart) {
			this.region = "preview";
			return { handled: true, render: true };
		}
		return undefined;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.panel.focusNext") || kb.matches(data, "app.panel.focusPrevious")) {
			this.region = this.region === "list" ? "preview" : "list";
		} else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			const delta = kb.matches(data, "tui.select.down") ? 1 : -1;
			if (this.region === "preview")
				this.previewOffset = moveViewport(this.previewOffset, this.previewLineCount, this.previewHeight, delta);
			else {
				this.selectedIndex = moveSelection(this.selectedIndex, this.messages.length, delta, true);
				this.previewOffset = 0;
			}
		} else if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.messages[this.selectedIndex];
			if (selected) this.onSelect?.(selected.id);
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
		}
	}
}

export class UserMessageSelectorComponent implements Component {
	private readonly messageList: UserMessageList;
	invalidate(): void {}

	constructor(
		messages: UserMessageItem[],
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		initialSelectedId?: string,
	) {
		this.messageList = new UserMessageList(messages, initialSelectedId);
		this.messageList.onSelect = onSelect;
		this.messageList.onCancel = onCancel;
		if (messages.length === 0) setTimeout(onCancel, 100);
	}

	setAvailableHeight(height: number): void {
		this.messageList.setAvailableHeight(height - 2);
	}
	render(width: number): string[] {
		return [theme.bold(theme.fg("accent", "Fork from Message")), "", ...this.messageList.render(width)];
	}
	handleInput(data: string): void {
		this.messageList.handleInput(data);
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.messageList.handleMouse({ ...event, y: event.y - 2 });
	}
	getMessageList(): UserMessageList {
		return this.messageList;
	}
}
