import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			setupFiles: ["./test/network-guard.ts"],
			exclude: [...configDefaults.exclude, "test/e2e/**"],
		},
	}),
);
