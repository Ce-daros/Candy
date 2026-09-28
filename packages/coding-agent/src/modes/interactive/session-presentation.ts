import type { AgentMessage } from "@candy/agent-core";
import type { AssistantMessage, Usage } from "@candy/ai";
import type { SessionEntry } from "../../core/session-manager.ts";
import { sessionEntryToContextMessages } from "../../core/session-manager.ts";
import type { AssistantMessageComponent } from "./components/assistant-message.ts";

export type CompactionCostNotice = {
	type: "compaction_cost";
	kind: "compaction" | "branch_summary";
	usage: Usage;
};

export type RenderSessionItem =
	| AgentMessage
	| Extract<SessionEntry, { type: "custom" | "usage" }>
	| CompactionCostNotice;

export class SessionPresentation {
	private readonly entriesRenderedByBoundaryCompaction = new Set<string>();
	private activeAssistantComponent: AssistantMessageComponent | undefined;
	private activeAssistantMessage: AssistantMessage | undefined;

	get streamingComponent(): AssistantMessageComponent | undefined {
		return this.activeAssistantComponent;
	}

	get streamingMessage(): AssistantMessage | undefined {
		return this.activeAssistantMessage;
	}

	beginStreaming(component: AssistantMessageComponent, message: AssistantMessage): void {
		this.activeAssistantComponent = component;
		this.activeAssistantMessage = message;
	}

	updateStreaming(message: AssistantMessage): void {
		this.activeAssistantMessage = message;
	}

	endStreaming(): void {
		this.activeAssistantComponent = undefined;
		this.activeAssistantMessage = undefined;
	}

	consumeBoundaryCompactionEntry(entryId: string): boolean {
		return this.entriesRenderedByBoundaryCompaction.delete(entryId);
	}

	markEntriesRenderedByBoundaryCompaction(entryIds: Iterable<string>): void {
		for (const entryId of entryIds) this.entriesRenderedByBoundaryCompaction.add(entryId);
	}

	projectEntries(entries: readonly SessionEntry[]): RenderSessionItem[] {
		return entries.flatMap((entry): RenderSessionItem[] => {
			if (entry.type === "custom" || (entry.type === "usage" && entry.kind === "cache_warm")) {
				return [entry];
			}
			const messages = sessionEntryToContextMessages(entry);
			if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage && messages.length > 0) {
				return [...messages, { type: "compaction_cost", kind: entry.type, usage: entry.usage }];
			}
			return messages;
		});
	}
}

export function isCustomSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "custom" }> {
	return "type" in item && item.type === "custom";
}

export function isCompactionCostNotice(item: RenderSessionItem): item is CompactionCostNotice {
	return "type" in item && item.type === "compaction_cost";
}

export function isUsageSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "usage" }> {
	return "type" in item && item.type === "usage";
}
