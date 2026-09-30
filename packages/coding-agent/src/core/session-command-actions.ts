import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import type { ExtensionCommandContextActions } from "./extensions/types.ts";

export function createSessionCommandActions(
	runtime: AgentSessionRuntime,
	presentation: Partial<ExtensionCommandContextActions> = {},
): ExtensionCommandContextActions {
	return {
		waitForIdle: () => runtime.session.waitForIdle(),
		newSession: (options) => runtime.newSession(options),
		fork: async (entryId, options) => {
			const result = await runtime.fork(entryId, options);
			return { cancelled: result.cancelled, selectedText: result.selectedText };
		},
		clone: (options) => runtime.clone(options),
		navigateTree: async (targetId, options) => {
			const result = await runtime.session.navigateTree(targetId, options);
			return { cancelled: result.cancelled, editorText: result.editorText };
		},
		switchSession: (path, options) => runtime.switchSession(path, options),
		reload: () => runtime.session.resources.reload(),
		...presentation,
	};
}
