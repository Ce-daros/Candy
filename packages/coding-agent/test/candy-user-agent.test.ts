import { describe, expect, it } from "vitest";
import { getCandyUserAgent } from "../src/utils/candy-user-agent.ts";

describe("getCandyUserAgent", () => {
	it("formats the user agent expected by pi.dev", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getCandyUserAgent("1.2.3");

		expect(userAgent).toBe(`candy/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^candy\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
