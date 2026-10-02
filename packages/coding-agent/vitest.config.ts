import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			exclude: [...configDefaults.exclude, "test/e2e/**", "test/**/*.bun.test.mjs"],
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			env: { CANDY_OFFLINE: "1" },
			unstubEnvs: true,
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
	}),
);
