import type { AgentMessage } from "@candy/agent-core";
import type { Message } from "@candy/ai";
import type { BoundaryContextPreview, SessionBoundaryDraft } from "./extensions/types.ts";
import { convertToLlm } from "./messages.ts";
import { type SessionEntry, SessionHistory } from "./session-history.ts";

function isRunnableContext(messages: readonly Message[]): boolean {
	const pendingTools = new Map<string, string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			if (pendingTools.size > 0) return false;
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				if (pendingTools.has(content.id)) return false;
				pendingTools.set(content.id, content.name);
			}
		} else if (message.role === "toolResult") {
			if (pendingTools.get(message.toolCallId) !== message.toolName) return false;
			pendingTools.delete(message.toolCallId);
		} else if (message.role === "user" && pendingTools.size > 0) return false;
	}
	return (
		pendingTools.size === 0 &&
		messages.some((message) => message.role !== "system") &&
		messages.at(-1)?.role !== "assistant"
	);
}

export class SessionBoundary {
	constructor(
		history: SessionHistory,
		getPendingMessages: () => AgentMessage[],
		onAppend: (entry: SessionEntry) => void,
	) {
		this.history = history;
		this.getPendingMessages = getPendingMessages;
		this.onAppend = onAppend;
	}
	private readonly history: SessionHistory;
	private readonly getPendingMessages: () => AgentMessage[];
	private readonly onAppend: (entry: SessionEntry) => void;
	private applyDrafts(manager: SessionHistory, drafts: readonly SessionBoundaryDraft[]): SessionEntry[] {
		const appended: SessionEntry[] = [];
		for (const draft of drafts) {
			let entryId: string;
			switch (draft.type) {
				case "custom":
					entryId = manager.appendCustomEntry(draft.customType, draft.data);
					break;
				case "custom_message":
					entryId = manager.appendCustomMessageEntry(
						draft.customType,
						draft.content,
						draft.display,
						draft.details,
					);
					break;
				case "context_edit":
					entryId = manager.appendContextEdit(draft.targetId, draft.replacement);
					break;
				default:
					throw new Error("Unsupported turn_end entry type");
			}
			appended.push(manager.getEntry(entryId)!);
		}
		return appended;
	}

	private createPreview(drafts: readonly SessionBoundaryDraft[]): SessionHistory {
		const header = this.history.getHeader();
		if (!header) throw new Error("Session header is missing");
		const manager = SessionHistory.inMemory(this.history.getCwd(), undefined, [header, ...this.history.getBranch()]);
		this.applyDrafts(manager, drafts);
		return manager;
	}

	preview(drafts: readonly SessionBoundaryDraft[]): BoundaryContextPreview {
		const projection = this.createPreview(drafts).buildSessionProjection();
		const pendingMessages = this.getPendingMessages();
		const llmMessages = convertToLlm(projection.messages);
		const contextCanContinue = isRunnableContext(convertToLlm([...projection.messages, ...pendingMessages]));
		return {
			contextEntries: projection.entries,
			contextMessages: projection.messages,
			llmMessages,
			pendingMessages,
			canContinue: contextCanContinue,
		};
	}

	commit(drafts: readonly SessionBoundaryDraft[]): void {
		const appended = this.applyDrafts(this.history, drafts);
		for (const entry of appended) this.onAppend(entry);
	}
}
