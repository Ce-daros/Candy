import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

if (process.env.MCP_FIXTURE_STDERR_BYTES) {
	await new Promise((resolve, reject) => {
		process.stderr.write(Buffer.alloc(Number(process.env.MCP_FIXTURE_STDERR_BYTES), 120), (error) =>
			error ? reject(error) : resolve(),
		);
	});
}

function createServer() {
	const server = new McpServer(
		{ name: "fixture-stdio", version: "1.0.0" },
		process.env.MCP_FIXTURE_LEGACY === "1" ? { supportedProtocolVersions: ["2025-11-25"] } : {},
	);
	server.registerTool("echo", { inputSchema: z.object({ value: z.string() }) }, async ({ value }) => ({
		content: [{ type: "text", text: value }],
	}));
	return server;
}

if (process.env.MCP_FIXTURE_LEGACY === "1") {
	await createServer().connect(new StdioServerTransport());
} else {
	serveStdio(createServer);
}
