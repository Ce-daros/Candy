import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

const evalConfig = defineConfig({
	test: {
		watch: false,
		passWithNoTests: false,
		pool: "forks",
		maxWorkers: 1,
		fileParallelism: false,
		projects: [
			{
				extends: true,
				test: {
					name: "host",
					include: ["evals/**/*.eval.ts"],
					sequence: { concurrent: false },
					testTimeout: 300_000,
					hookTimeout: 300_000,
				},
			},
		],
	},
});

export default mergeConfig(baseConfig, evalConfig);
