import { type FauxResponseStep, fauxProvider } from "@candy/ai/providers/faux";
import { getTestAgent } from "../execution-internals.ts";
import type { Harness } from "./harness.ts";

export function useSummaryResponses(harness: Harness, responses: FauxResponseStep[]) {
	const summary = fauxProvider();
	summary.setResponses(responses);
	const agent = getTestAgent(harness.session.execution);
	const stream = agent.streamFunction;
	agent.streamFunction = (model, context, options) =>
		options?.sessionId === harness.session.history.getSessionId()
			? stream(model, context, options)
			: summary.provider.streamSimple(model, context, options);
	return summary;
}
