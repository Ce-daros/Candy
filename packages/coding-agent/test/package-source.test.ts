import { describe, expect, it } from "vitest";
import { parsePackageSource } from "../src/core/package-source.ts";

describe("parsePackageSource", () => {
	it("separates npm package identity and version policy", () => {
		expect(parsePackageSource("npm:@scope/package@1.2.3")).toEqual({
			type: "npm",
			spec: "@scope/package@1.2.3",
			name: "@scope/package",
			version: "1.2.3",
			range: "1.2.3",
			pinned: true,
		});
		expect(parsePackageSource("npm:package@^1.2.3")).toMatchObject({
			type: "npm",
			name: "package",
			range: ">=1.2.3 <2.0.0-0",
			pinned: false,
		});
	});

	it("accepts supported git URLs while keeping shorthand opt-in", () => {
		expect(parsePackageSource("git:github.com/user/repo@main")).toMatchObject({
			type: "git",
			host: "github.com",
			path: "user/repo",
			ref: "main",
			pinned: true,
		});
		expect(parsePackageSource("github.com/user/repo")).toEqual({
			type: "local",
			path: "github.com/user/repo",
		});
	});

	it("preserves local paths verbatim for scope-based resolution", () => {
		expect(parsePackageSource("../packages/agent-timers")).toEqual({
			type: "local",
			path: "../packages/agent-timers",
		});
	});
});
