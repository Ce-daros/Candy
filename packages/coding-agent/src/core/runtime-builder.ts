import type { CreateAgentSessionRuntimeFactory } from "./agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	assembleAgentSessionFromServices,
	assembleAgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
} from "./agent-session-services.ts";

type RuntimeTarget = Parameters<CreateAgentSessionRuntimeFactory>[0];
type Selection = Omit<CreateAgentSessionFromServicesOptions, "services" | "sessionManager" | "sessionStartEvent">;
type ServiceOptions = { options: CreateAgentSessionServicesOptions; diagnostics?: AgentSessionRuntimeDiagnostic[] };

export function buildRuntimeFactory(options: {
	services(target: RuntimeTarget): ServiceOptions | Promise<ServiceOptions>;
	select(
		services: AgentSessionServices,
		target: RuntimeTarget,
	): Promise<{
		options: Selection;
		diagnostics?: AgentSessionRuntimeDiagnostic[];
	}>;
}): CreateAgentSessionRuntimeFactory {
	return async (target) => {
		const setup = await options.services(target);
		const services = await assembleAgentSessionServices(setup.options);
		services.diagnostics.push(...(setup.diagnostics ?? []));
		try {
			const selected = await options.select(services, target);
			const created = await assembleAgentSessionFromServices({
				...selected.options,
				services,
				sessionManager: target.sessionManager,
				sessionStartEvent: target.sessionStartEvent,
			});
			return { ...created, services, diagnostics: [...services.diagnostics, ...(selected.diagnostics ?? [])] };
		} catch (error) {
			try {
				await services.dispose();
			} catch (disposeError) {
				throw new AggregateError([error, disposeError], "Session creation and services cleanup failed");
			}
			throw error;
		}
	};
}
