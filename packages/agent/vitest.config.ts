import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));
const aiSrcApi = fileURLToPath(new URL("../ai/src/api", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const aiSrcProviders = fileURLToPath(new URL("../ai/src/providers", import.meta.url));
const aiSrcUtils = fileURLToPath(new URL("../ai/src/utils", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@candy\/telemetry$/, replacement: telemetrySrcIndex },
			{ find: /^@candy\/ai$/, replacement: aiSrcIndex },
			{ find: /^@candy\/ai\/api\/(.+)$/, replacement: `${aiSrcApi}/$1.ts` },
			{ find: /^@candy\/ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@candy\/ai\/providers\/(.+)$/, replacement: `${aiSrcProviders}/$1.ts` },
			{ find: /^@candy\/ai\/utils\/(.+)$/, replacement: `${aiSrcUtils}/$1.ts` },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
