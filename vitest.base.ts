import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiApi: fileURLToPath(new URL("./packages/ai/src/api", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	aiUtils: fileURLToPath(new URL("./packages/ai/src/utils", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	codingAgentExtensionHostModules: fileURLToPath(
		new URL("./packages/coding-agent/src/presentation/extensions/virtual-modules.ts", import.meta.url),
	),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@candy\/telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@candy\/telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@candy\/ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@candy\/ai\/api\/(.+)$/, replacement: `${workspaceSourcePaths.aiApi}/$1.ts` },
			{ find: /^@candy\/ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@candy\/ai\/utils\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiUtils}/$1.ts`,
			},
			{
				find: /^@candy\/ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@candy\/agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@candy\/tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
