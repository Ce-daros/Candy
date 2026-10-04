import { readFileSync, rmSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { mcpResourceResult, mcpToolResult } from "../src/core/mcp/result.ts";

const savedPaths: string[] = [];
afterEach(() => {
	for (const path of savedPaths.splice(0)) rmSync(path);
});

test.each(["text", "blob"])("converts %s resources consistently in tool and resource results", async (kind) => {
	const uri = "fixture://shared-resource";
	const resource =
		kind === "text"
			? { uri, text: "Resource body", _meta: { secret: "private" } }
			: {
					uri,
					blob: Buffer.from("Resource body").toString("base64"),
					mimeType: "text/plain",
					_meta: { secret: "private" },
				};
	const results = await Promise.all([
		mcpToolResult({ content: [{ type: "resource", resource }] }),
		mcpResourceResult({ contents: [resource] }),
	]);
	for (const result of results) {
		expect(JSON.stringify(result.structuredContent)).not.toContain("_meta");
		if (kind === "text") expect(result.content).toEqual([{ type: "text", text: `${uri}\nResource body` }]);
		else {
			const { files } = result.structuredContent as {
				files: Array<{ path: string; mimeType: string; description: string }>;
			};
			savedPaths.push(...files.map((file) => file.path));
			expect(files).toHaveLength(1);
			expect(files[0]).toMatchObject({ mimeType: "text/plain", description: uri });
			expect(readFileSync(files[0].path, "utf8")).toBe("Resource body");
			expect(result.content).toEqual([{ type: "text", text: `${uri}: ${files[0].path} (text/plain)` }]);
		}
	}
});
