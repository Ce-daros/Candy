import type { Agent, ThinkingLevel } from "@candy/agent-core";
import type { Model } from "@candy/ai";
import { clampThinkingLevel, getSupportedThinkingLevels, modelsAreEqual } from "@candy/ai";
import { THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SessionHistory } from "./session-history.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface ModelMutationOptions {
	/** Cancel an in-flight authentication check before the model is applied. */
	signal?: AbortSignal;
}

interface ModelSelectionCallbacks {
	isDisposed: () => boolean;
	isBusy: () => boolean;
	onThinkingLevelChange: (level: ThinkingLevel, previousLevel: ThinkingLevel) => void;
}

export class ModelSelection {
	private readonly agent: Agent;
	private readonly modelRuntime: ModelRuntime;
	private readonly sessionManager: SessionHistory;
	private readonly settingsManager: SettingsManager;
	private readonly callbacks: ModelSelectionCallbacks;
	private selectionRevision = 0;

	constructor(
		agent: Agent,
		modelRuntime: ModelRuntime,
		sessionManager: SessionHistory,
		settingsManager: SettingsManager,
		callbacks: ModelSelectionCallbacks,
	) {
		this.agent = agent;
		this.modelRuntime = modelRuntime;
		this.sessionManager = sessionManager;
		this.settingsManager = settingsManager;
		this.callbacks = callbacks;
	}

	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return [...THINKING_LEVEL_OPTIONS];
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	async setModel(model: Model<any>, options: ModelMutationOptions = {}): Promise<void> {
		const revision = ++this.selectionRevision;
		options.signal?.throwIfAborted();
		if (this.callbacks.isDisposed()) throw new Error("Session was disposed before the model could be set");
		const authenticated = await this.modelRuntime.checkAuth(model.provider, { signal: options.signal });
		options.signal?.throwIfAborted();
		if (revision !== this.selectionRevision) return;
		if (this.callbacks.isDisposed()) throw new Error("Session was disposed before the model could be set");
		if (!authenticated) throw new Error(`No API key for ${model.provider}/${model.id}`);

		const previousModel = this.model;
		if (modelsAreEqual(previousModel, model)) return;
		const previousThinkingLevel = this.thinkingLevel;
		const thinkingLevel = clampThinkingLevel(model, this.getThinkingLevelForModelSwitch(model)) as ThinkingLevel;
		const thinkingChanged = thinkingLevel !== previousThinkingLevel;
		this.sessionManager.appendModelSelection(model.provider, model.id, thinkingChanged ? thinkingLevel : undefined);
		this.agent.state.model = model;
		this.agent.state.thinkingLevel = thinkingLevel;

		if (thinkingChanged) this.callbacks.onThinkingLevelChange(thinkingLevel, previousThinkingLevel);
	}

	clearModel(): void {
		if (this.callbacks.isDisposed()) throw new Error("Session was disposed before the model could be cleared");
		if (this.callbacks.isBusy()) throw new Error("Cannot clear the model while the session is busy");
		this.selectionRevision++;
		this.agent.clearModel();
	}

	setThinkingLevel(level: ThinkingLevel): void {
		if (this.callbacks.isDisposed()) throw new Error("Session was disposed before the thinking level could be set");
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this.clampThinkingLevel(level);
		const previousLevel = this.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this.agent.state.thinkingLevel = effectiveLevel;
			this.callbacks.onThinkingLevelChange(effectiveLevel, previousLevel);
		}
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;
		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextLevel = levels[(currentIndex + 1) % levels.length];
		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	refreshFromRegistry(): void {
		this.selectionRevision++;
		const currentModel = this.model;
		if (!currentModel) return;
		const refreshedModel = this.modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (refreshedModel && refreshedModel !== currentModel) this.agent.state.model = refreshedModel;
	}

	private getThinkingLevelForModelSwitch(targetModel?: Model<any>, explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) return explicitLevel;
		if (targetModel) {
			const perModel = this.settingsManager.getModelThinkingLevel(targetModel.provider, targetModel.id);
			if (perModel !== undefined) return perModel;
		}
		return this.settingsManager.getDefaultThinkingLevel() ?? this.thinkingLevel;
	}

	private clampThinkingLevel(level: ThinkingLevel): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}
}
