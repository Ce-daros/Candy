import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));

/**
 * Live provider verification. These tests call real provider endpoints with
 * ambient credentials from the environment or `~/.candy/agent/auth.json`.
 *
 * Run explicitly with `npm run test:e2e`. Providers without credentials stay
 * skipped. This config is not used by `npm test` and must not be wired into CI.
 */
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["test/e2e/**/*.test.ts"],
		testTimeout: 180000,
		hookTimeout: 60000,
		reporters: ["dot"],
	},
	resolve: {
		alias: [{ find: /^@earendil-works\/pi-telemetry$/, replacement: telemetrySrcIndex }],
	},
});
