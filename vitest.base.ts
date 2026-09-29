import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { repositoryRoot, workspacePackages } from "./scripts/lib/workspace-paths.mjs";

const sourceRoot = (packageName: string): string => {
	const root = workspacePackages().get(packageName);
	if (!root) throw new Error(`Unknown workspace package ${packageName}`);
	return join(repositoryRoot, root);
};

export const workspaceSourcePaths = {
	telemetryIndex: join(sourceRoot("@candy/telemetry"), "index.ts"),
	telemetryTesting: join(sourceRoot("@candy/telemetry"), "testing/index.ts"),
	aiIndex: join(sourceRoot("@candy/ai"), "index.ts"),
	aiApi: join(sourceRoot("@candy/ai"), "api"),
	aiOAuth: join(sourceRoot("@candy/ai"), "oauth.ts"),
	aiProviders: join(sourceRoot("@candy/ai"), "providers"),
	aiUtils: join(sourceRoot("@candy/ai"), "utils"),
	agentIndex: join(sourceRoot("@candy/agent-core"), "index.ts"),
	codingAgentIndex: join(sourceRoot("@candy/coding-agent"), "index.ts"),
	codingAgentExtensionHostModules: join(sourceRoot("@candy/coding-agent"), "presentation/extensions/virtual-modules.ts"),
	tuiIndex: join(sourceRoot("@candy/tui"), "index.ts"),
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
