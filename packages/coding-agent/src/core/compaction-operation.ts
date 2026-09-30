import type { Agent, ThinkingLevel } from "@candy/agent-core";
import type { Model, RetryCallbacks } from "@candy/ai";
import { estimateMessageTokens } from "@candy/ai/utils/estimate";
import { type CompactionResult, compact, prepareCompaction } from "./compaction/index.ts";
import type { SessionHistory } from "./session-history.ts";
import type { SettingsManager } from "./settings-manager.ts";

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface CompactionOperationHost {
	readonly agent: Agent;
	readonly model: Model<any> | undefined;
	readonly sessionManager: SessionHistory;
	readonly settingsManager: SettingsManager;
	readonly thinkingLevel: ThinkingLevel;
	getSummarizationRequestAuth(
		model: Model<any>,
		signal: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}>;
	summarizationRetryCallbacks(reason: CompactionReason): RetryCallbacks;
}

export interface CompactionOperationOptions {
	reason: CompactionReason;
	customInstructions?: string;
	willRetry: boolean;
	signal: AbortSignal;
	allowEmptyPreparation: boolean;
}

export interface CompactionOperationResult {
	result: CompactionResult;
	fromExtension: boolean;
}

export class CompactionCancelledError extends Error {
	constructor() {
		super("Compaction cancelled");
		this.name = "CompactionCancelledError";
	}
}

export class CompactionOperation {
	private readonly host: CompactionOperationHost;
	private manualController: AbortController | undefined;
	private automaticController: AbortController | undefined;

	constructor(host: CompactionOperationHost) {
		this.host = host;
	}

	start(kind: "manual" | "automatic"): AbortController {
		const controller = new AbortController();
		if (kind === "manual") this.manualController = controller;
		else this.automaticController = controller;
		return controller;
	}

	finish(kind: "manual" | "automatic", controller?: AbortController): void {
		if (kind === "manual" && (controller === undefined || this.manualController === controller)) {
			this.manualController = undefined;
		}
		if (kind === "automatic" && (controller === undefined || this.automaticController === controller)) {
			this.automaticController = undefined;
		}
	}

	abort(): void {
		this.manualController?.abort();
		this.automaticController?.abort();
	}

	get isRunning(): boolean {
		return this.manualController !== undefined || this.automaticController !== undefined;
	}

	async run(options: CompactionOperationOptions): Promise<CompactionOperationResult | undefined> {
		const model = this.host.model;
		if (!model) throw new Error("No model selected");
		const thinkingLevel = this.host.thinkingLevel;
		const settings = this.host.settingsManager.getCompactionSettings(model);
		const branchEntries = this.host.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, settings);
		if (!preparation) {
			if (options.allowEmptyPreparation) return undefined;
			const lastEntry = branchEntries.at(-1);
			if (lastEntry?.type === "compaction") throw new Error("Already compacted");
			throw new Error("Nothing to compact (session too small)");
		}

		this.assertNotAborted(options.signal);
		const {
			model: requestModel,
			apiKey,
			headers,
			env,
		} = await this.host.getSummarizationRequestAuth(model, options.signal);

		const fromExtension = false;
		let result: CompactionResult;
		try {
			result = await compact(
				preparation,
				requestModel,
				apiKey,
				headers,
				options.customInstructions,
				options.signal,
				thinkingLevel,
				this.host.agent.streamFunction,
				env,
				this.host.settingsManager.getRetrySettings(),
				this.host.summarizationRetryCallbacks(options.reason),
				undefined,
			);
		} catch (error) {
			if (options.signal.aborted) throw new CompactionCancelledError();
			throw error;
		}
		this.assertNotAborted(options.signal);

		const entryId = this.host.sessionManager.appendCompaction(
			result.summary,
			result.firstKeptEntryId,
			result.tokensBefore,
			result.details,
			fromExtension,
			result.usage,
		);
		const savedEntry = this.host.sessionManager.getEntry(entryId);
		if (!savedEntry || savedEntry.type !== "compaction") {
			throw new Error(`Compaction entry ${entryId} was not committed`);
		}
		const projectedMessages = this.host.sessionManager.buildSessionProjection().messages;
		const completedResult: CompactionResult = {
			...result,
			estimatedTokensAfter: projectedMessages.reduce((total, message) => total + estimateMessageTokens(message), 0),
		};
		return { result: completedResult, fromExtension };
	}

	private assertNotAborted(signal: AbortSignal): void {
		if (signal.aborted) throw new CompactionCancelledError();
	}
}
