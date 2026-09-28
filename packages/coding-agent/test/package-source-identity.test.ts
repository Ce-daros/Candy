import { describe, expect, it } from "vitest";
import { packageSourceIdentity } from "../src/core/package-source-identity.ts";

describe("package source identity", () => {
	it("treats npm versions as the same package", () => {
		const resolveLocalPath = (path: string) => path;
		expect(packageSourceIdentity("npm:@scope/addon@1.0.0", resolveLocalPath)).toBe("npm:@scope/addon");
		expect(packageSourceIdentity("npm:@scope/addon@^2", resolveLocalPath)).toBe("npm:@scope/addon");
	});

	it("normalizes Git URL forms to host and repository path", () => {
		const resolveLocalPath = (path: string) => path;
		const identity = packageSourceIdentity("git:git@github.com:owner/repo@v1", resolveLocalPath);
		expect(identity).toBe("git:github.com/owner/repo");
		expect(packageSourceIdentity("https://github.com/owner/repo", resolveLocalPath)).toBe(identity);
	});

	it("delegates local identity to the caller's scope resolver", () => {
		expect(packageSourceIdentity("./extensions", (path) => `/project/.candy/${path}`)).toBe(
			"local:/project/.candy/./extensions",
		);
	});
});
