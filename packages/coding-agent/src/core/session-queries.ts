import type { AssistantMessage, Model } from "@candy/ai";
import { contentText, getCurrentSystemMessage } from "@candy/ai";
import {
	type ContextUsageEstimate,
	calculateContextTokens,
	estimateContextTokens,
	estimateMessageTokens,
} from "@candy/ai/utils/estimate";
import type { ContextUsage } from "./extensions/types.ts";
import { getLatestCompactionEntry } from "./session-projection.ts";
import type { ReadonlySessionHistory, SessionEntry, SessionProjection } from "./session-records.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

/**
 * Get all user messages from session for fork selector.
 */
export function getUserMessagesForForking(history: ReadonlySessionHistory): Array<{ entryId: string; text: string }> {
	const entries = history.getEntries();
	const result: Array<{ entryId: string; text: string }> = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role !== "user") continue;

		const text = contentText(entry.message.content, "");
		if (text) {
			result.push({ entryId: entry.id, text });
		}
	}

	return result;
}

/**
 * Get session statistics. Aggregates over ALL session entries (including
 * history that was compacted away), so token/cost totals reflect what was
 * actually billed across the session.
 */
export function getSessionStats(history: ReadonlySessionHistory, model?: Model<any>): SessionStats {
	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	let totalMessages = 0;
	let toolCalls = 0;
	const usageTotals = createUsageTotals();

	for (const entry of history.getEntries()) {
		if (entry.type === "usage") {
			addUsageToTotals(usageTotals, entry.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsageToTotals(usageTotals, entry.usage);
		}
		if (entry.type !== "message") continue;
		totalMessages++;
		const message = entry.message;
		if (message.role === "user") {
			userMessages++;
		} else if (message.role === "toolResult") {
			toolResults++;
			if (message.usage) {
				addUsageToTotals(usageTotals, message.usage);
			}
		} else if (message.role === "assistant") {
			assistantMessages++;
			const assistantMsg = message as AssistantMessage;
			if (Array.isArray(assistantMsg.content)) {
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
			}
			addUsageToTotals(usageTotals, assistantMsg.usage);
		}
	}

	return {
		sessionFile: history.getSessionFile(),
		sessionId: history.getSessionId(),
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages,
		tokens: {
			input: usageTotals.input,
			output: usageTotals.output,
			cacheRead: usageTotals.cacheRead,
			cacheWrite: usageTotals.cacheWrite,
			total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
		},
		cost: usageTotals.cost,
		contextUsage: getContextUsage(history, model),
	};
}

export function getContextUsage(history: ReadonlySessionHistory, model?: Model<any>): ContextUsage | undefined {
	if (!model) return undefined;

	const contextWindow = model.contextWindow ?? 0;
	if (contextWindow <= 0) return undefined;

	// After compaction, the last assistant usage reflects pre-compaction context size.
	// We can only trust usage from an assistant that responded after the latest compaction.
	// If no such assistant exists, context token count is unknown until the next LLM response.
	const projection = history.buildSessionProjection();
	const branch = history.getBranch();
	const latestCompaction = getLatestCompactionEntry(branch);

	if (latestCompaction) {
		const projectedAssistants = new Set(
			projection.entries.flatMap((entry) =>
				entry.messages.some(
					(message) =>
						message.role === "assistant" &&
						message.stopReason !== "aborted" &&
						message.stopReason !== "error" &&
						calculateContextTokens(message.usage) > 0,
				)
					? [entry.sourceEntry.id]
					: [],
			),
		);
		const compactionIndex = branch.findIndex((entry) => entry.id === latestCompaction.id);
		const hasPostCompactionUsage = branch
			.slice(compactionIndex + 1)
			.some((entry) => projectedAssistants.has(entry.id));
		if (!hasPostCompactionUsage) return { tokens: null, contextWindow, percent: null };
	}

	const estimate = estimateProjectedContextTokens(projection, branch);
	const percent = (estimate.tokens / contextWindow) * 100;

	return {
		tokens: estimate.tokens,
		contextWindow,
		percent,
	};
}

/**
 * Get text content of last assistant message.
 * Useful for the Copy action.
 * @returns Text content, or undefined if no assistant message exists
 */
export function getLastAssistantText(history: ReadonlySessionHistory): string | undefined {
	const lastAssistant = history
		.buildSessionProjection()
		.messages.slice()
		.reverse()
		.find((m) => {
			if (m.role !== "assistant") return false;
			const msg = m as AssistantMessage;
			// Skip aborted messages with no content
			if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
			return true;
		});

	if (!lastAssistant) return undefined;

	let text = "";
	for (const content of (lastAssistant as AssistantMessage).content) {
		if (content.type === "text") {
			text += content.text;
		}
	}

	return text.trim() || undefined;
}

/** Estimate projected context without trusting usage captured before a later edit or compaction. */
export function estimateProjectedContextTokens(
	projection: SessionProjection,
	branchEntries: SessionEntry[],
): ContextUsageEstimate {
	const estimate = estimateContextTokens(projection.messages);
	if (estimate.lastUsageIndex !== null) {
		let projectedMessageIndex = 0;
		let usageEntryId: string | undefined;
		for (const entry of projection.entries) {
			const nextMessageIndex = projectedMessageIndex + entry.messages.length;
			if (estimate.lastUsageIndex < nextMessageIndex) {
				usageEntryId = entry.sourceEntry.id;
				break;
			}
			projectedMessageIndex = nextMessageIndex;
		}

		const usageEntryIndex = usageEntryId ? branchEntries.findIndex((entry) => entry.id === usageEntryId) : -1;
		let latestInvalidatingEntryIndex = -1;
		for (let i = branchEntries.length - 1; i >= 0; i--) {
			const entry = branchEntries[i];
			if (entry.type === "context_edit" || entry.type === "compaction") {
				latestInvalidatingEntryIndex = i;
				break;
			}
		}
		if (usageEntryIndex > latestInvalidatingEntryIndex) return estimate;
	}

	const currentSystem = getCurrentSystemMessage(projection.messages);
	let tokens = currentSystem ? estimateMessageTokens(currentSystem) : 0;
	for (const message of projection.messages) {
		if (message.role !== "system") tokens += estimateMessageTokens(message);
	}
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}
