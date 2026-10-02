import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		resolve: { conditions: ["source"] },
		ssr: { resolve: { conditions: ["source"] } },
	}),
);
