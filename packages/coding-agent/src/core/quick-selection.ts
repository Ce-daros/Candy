import { type Api, type Model, modelsAreEqual } from "@candy/ai";
import type { AgentSession } from "./agent-session.ts";

export type QuickSelectionReconcileResult = "unchanged" | "selected" | "empty";

/** Return available models in the same order used by the Powerbar. */
export function getQuickSelectionModels(session: AgentSession): Model<Api>[] {
	const scope = session.execution.settingsManager.getScopedModels();
	return session.execution.modelRuntime
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
	if (session.execution.isDisposed) throw new Error("Session was disposed before quick selection could be reconciled");
	if (session.execution.isStreaming || session.execution.isCompacting) {
		throw new Error("Cannot reconcile quick selection while the session is busy");
	}
	const models = getQuickSelectionModels(session);
	const current = session.selection.model;
	if (current && models.some((model) => modelsAreEqual(model, current))) return "unchanged";
	if (models.length === 0) {
		session.selection.clearModel();
		return "empty";
	}
	session.selection.clearModel();
	await session.selection.setModel(models[0], { signal });
	return "selected";
}
