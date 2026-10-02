import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "./scripts/lib/workspace-paths.mjs";

export default defineConfig({
	resolve: { alias: workspaceSourceAliases() },
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
});
