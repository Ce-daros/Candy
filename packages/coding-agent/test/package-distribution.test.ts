import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface CodingAgentPackageJson {
	bin: { candy: string };
	main: string;
	exports: Record<string, { import: string; types?: string }>;
}

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CodingAgentPackageJson;

describe("package distribution entrypoints", () => {
	test("publishes the SDK, UI, RPC, extension host, and executable entrypoints", () => {
		expect(packageJson.bin.candy).toBe("dist/bundle/cli.js");
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.exports).toEqual({
			".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
			"./rpc-entry": { import: "./dist/bundle/rpc-entry.js" },
			"./extension-host-modules": {
				types: "./dist/presentation/extensions/virtual-modules.d.ts",
				import: "./dist/presentation/extensions/virtual-modules.js",
			},
			"./ui": { types: "./dist/ui.d.ts", import: "./dist/ui.js" },
			"./rpc": { types: "./dist/rpc.d.ts", import: "./dist/rpc.js" },
		});
	});
});
