import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

serveStdio(() => {
	const server = new McpServer({ name: "Candy acceptance fixture", version: "1.0.0" });
	server.registerTool("query", {
		description: "Query a synthetic record by ID (1, 2, or 3). Returns amount 10, 20, or 30.",
		inputSchema: z.object({ id: z.number().int().min(1).max(3) }),
		outputSchema: z.object({ id: z.number(), amount: z.number() }),
	}, async ({ id }) => ({ content: [{ type: "text", text: JSON.stringify({ id, amount: id * 10 }) }], structuredContent: { id, amount: id * 10 } }));
	server.registerTool("media", {
		description: "Return a synthetic PNG and WAV audio. No external generation service is used.",
		inputSchema: z.object({}),
	}, async () => ({ content: [
		{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII=" },
		{ type: "audio", mimeType: "audio/wav", data: Buffer.from("RIFF$\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x40\x1f\0\0\x01\0\x08\0data\0\0\0\0", "binary").toString("base64") },
	] }));
	return server;
});
