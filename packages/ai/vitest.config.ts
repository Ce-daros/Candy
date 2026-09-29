import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		// Live provider tests under test/e2e require real credentials and network access.
		// They are opt-in through `npm run test:e2e`, so the default run never imports them.
		exclude: [...configDefaults.exclude, "test/e2e/**"],
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
});