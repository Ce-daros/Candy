import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.base.ts";

/**
 * Live provider verification. These tests call real provider endpoints with
 * ambient credentials from the environment or `~/.candy/agent/auth.json`.
 *
 * Run explicitly with `npm run test:e2e`. Providers without credentials stay
 * skipped. This config is not used by `npm test` and must not be wired into CI.
 */
export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["test/e2e/**/*.test.ts"],
			testTimeout: 180000,
			hookTimeout: 60000,
		},
	}),
);
