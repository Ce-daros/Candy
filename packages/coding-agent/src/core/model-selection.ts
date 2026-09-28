import type { Agent, ThinkingLevel } from "@candy/agent-core";
import type { Model } from "@candy/ai";
import { clampThinkingLevel, getSupportedThinkingLevels, modelsAreEqual } from "@candy/ai";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface ModelMutationOptions {
	/** Persist the model to global defaults. Defaults to session-only. */
	persist?: boolean;
	/** Cancel an in-flight authentication check before the model is applied. */
	signal?: AbortSignal;
}

interface ModelSelectionCallbacks {
	isDisposed: () => boolean;
	isBusy: () => boolean;
	onModelSelect: (model: Model<any>, previousModel: Model<any> | undefined) => Promise<void>;
	onThinkingLevelChange: (level: ThinkingLevel, previousLevel: ThinkingLevel) => void;
}

export class ModelSelection {
	private readonly agent: Agent;
	private readonly modelRuntime: ModelRuntime;
	private readonly sessionManager: SessionManager;
	private readonly settingsManager: SettingsManager;
	private readonly callbacks: ModelSelectionCallbacks;

	constructor(
		agent: Agent,
		modelRuntime: ModelRuntime,
		sessionManager: SessionManager,
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
		options.signal?.throwIfAborted();
		if (this.callbacks.isDisposed()) throw new Error("Session was disposed before the model could be set");
		const authenticated = await this.modelRuntime.checkAuth(model.provider, { signal: options.signal });
		options.signal?.throwIfAborted();
		if (this.callbacks.isDisposed()) throw new Error("Session was disposed before the model could be set");
		if (!authenticated) throw new Error(`No API key for ${model.provider}/${model.id}`);

		const previousModel = this.model;
		const thinkingLevel = this.getThinkingLevelForModelSwitch(model);
		if (options.persist) {
			await this.settingsManager.mutateAndPersist(() =>
				this.settingsManager.setDefaultModelAndProvider(model.provider, model.id),
			);
			options.signal?.throwIfAborted();
			if (this.callbacks.isDisposed()) throw new Error("Session was disposed before the model could be set");
		}
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.setThinkingLevel(thinkingLevel);

		if (!modelsAreEqual(previousModel, model)) await this.callbacks.onModelSelect(model, previousModel);
	}

	clearModel(): void {
		if (this.callbacks.isDisposed()) throw new Error("Session was disposed before the model could be cleared");
		if (this.callbacks.isBusy()) throw new Error("Cannot clear the model while the session is busy");
		this.agent.clearModel();
	}

	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this.clampThinkingLevel(level);
		const previousLevel = this.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;
		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
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
		return this.settingsManager.getDefaultThinkingLevel() ?? this.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	}

	private clampThinkingLevel(level: ThinkingLevel): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}
}
