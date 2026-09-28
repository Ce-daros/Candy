import { type Api, type Model, modelsAreEqual } from "@candy/ai";
import type { AgentSession } from "./agent-session.ts";

export type QuickSelectionReconcileResult = "unchanged" | "selected" | "empty";

/** Return available models in the same order used by the Powerbar. */
export function getQuickSelectionModels(session: AgentSession): Model<Api>[] {
	const scope = session.settingsManager.getScopedModels();
	return session.modelRuntime
		.getAvailableSnapshot()
		.filter(
			(model) =>
				scope === undefined || scope.some((ref) => ref.provider === model.provider && ref.modelId === model.id),
		);
}

/** Reconcile the active model after a quick-selection edit. */
export async function reconcileQuickSelection(
	session: AgentSession,
	signal?: AbortSignal,
): Promise<QuickSelectionReconcileResult> {
	signal?.throwIfAborted();
	if (session.isDisposed) throw new Error("Session was disposed before quick selection could be reconciled");
	if (session.isStreaming || session.isCompacting) {
		throw new Error("Cannot reconcile quick selection while the session is busy");
	}
	const models = getQuickSelectionModels(session);
	const current = session.model;
	if (current && models.some((model) => modelsAreEqual(model, current))) return "unchanged";
	if (models.length === 0) {
		session.clearModel();
		return "empty";
	}
	session.clearModel();
	await session.setModel(models[0], { persist: false, signal });
	return "selected";
}
