import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["test/e2e/**/*.test.ts"],
			exclude: [...configDefaults.exclude],
			testTimeout: 180000,
			hookTimeout: 60000,
			unstubEnvs: true,
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
	}),
);
