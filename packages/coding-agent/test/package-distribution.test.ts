import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface CodingAgentPackageJson {
	bin: { candy: string };
	main: string;
	exports: {
		".": { import: string; types: string };
		"./rpc-entry": { import: string };
	};
}

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CodingAgentPackageJson;

describe("package distribution entrypoints", () => {
	test("uses the bundle for executables and modular output for libraries", () => {
		expect(packageJson.bin.candy).toBe("dist/bundle/cli.js");
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.exports["."].import).toBe("./dist/index.js");
		expect(packageJson.exports["./rpc-entry"].import).toBe("./dist/bundle/rpc-entry.js");
	});

	test("publishes only the SDK and RPC entrypoints", () => {
		expect(packageJson.exports).toEqual({
			".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
			"./rpc-entry": { import: "./dist/bundle/rpc-entry.js" },
		});
	});
});
