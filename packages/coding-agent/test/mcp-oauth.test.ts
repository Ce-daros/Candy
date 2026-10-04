import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredOAuthTokens } from "@modelcontextprotocol/client";
import { expect, test } from "vitest";
import { loginToMcpServer, McpOAuthStore } from "../src/core/mcp/oauth.ts";

test("rejects an OAuth callback with a different issuer before token exchange", async () => {
	let issuer = "";
	let tokenRequests = 0;
	const http = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", issuer).pathname;
		response.setHeader("content-type", "application/json");
		if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
			response.end(JSON.stringify({ resource: `${issuer}/mcp`, authorization_servers: [issuer] }));
		} else if (pathname.startsWith("/.well-known/oauth-authorization-server")) {
			response.end(
				JSON.stringify({
					issuer,
					authorization_endpoint: `${issuer}/authorize`,
					token_endpoint: `${issuer}/token`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
				}),
			);
		} else if (pathname === "/token") {
			tokenRequests++;
			response.end(JSON.stringify({ access_token: "must-not-be-issued", token_type: "Bearer" }));
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	issuer = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
	const root = mkdtempSync(join(tmpdir(), "candy-mcp-oauth-"));
	try {
		await expect(
			loginToMcpServer(
				"fixture",
				{ url: `${issuer}/mcp`, oauth: { clientId: "candy-test" } },
				new McpOAuthStore(root),
				async (interaction) => {
					if (interaction.type !== "authorization") throw new Error("Expected authorization URL");
					const authorization = new URL(interaction.url);
					const redirect = new URL(authorization.searchParams.get("redirect_uri")!);
					redirect.searchParams.set("code", "synthetic-code");
					redirect.searchParams.set("state", authorization.searchParams.get("state")!);
					redirect.searchParams.set("iss", `${issuer}/wrong`);
					const callback = await fetch(redirect);
					expect(callback.status).toBe(200);
					return { action: "accept" };
				},
			),
		).rejects.toThrow(/issuer/i);
		expect(tokenRequests).toBe(0);
	} finally {
		await new Promise<void>((resolve) => http.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});

test("persists MCP tokens per server URL and issuer, then removes them on logout", () => {
	const root = mkdtempSync(join(tmpdir(), "candy-mcp-credentials-"));
	try {
		const store = new McpOAuthStore(root);
		const tokens = {
			access_token: "synthetic",
			token_type: "Bearer",
			issuer: "https://issuer.example",
		} as StoredOAuthTokens;
		store.update("service", "https://service.example/mcp", "https://issuer.example", { tokens });
		const reloaded = new McpOAuthStore(root);
		expect(
			reloaded.get("service", "https://service.example/mcp", "https://issuer.example")?.tokens?.access_token,
		).toBe("synthetic");
		expect(reloaded.get("service", "https://service.example/mcp", "https://another-issuer.example")).toBeUndefined();
		expect(reloaded.get("other", "https://service.example/mcp")).toBeUndefined();
		reloaded.remove("service", "https://service.example/mcp");
		expect(reloaded.accessToken("service", "https://service.example/mcp")).toBeUndefined();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("finishes an explicit OAuth login and stores the issued token", async () => {
	let issuer = "";
	const http = createServer(async (request, response) => {
		const pathname = new URL(request.url ?? "/", issuer).pathname;
		response.setHeader("content-type", "application/json");
		if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
			response.end(JSON.stringify({ resource: `${issuer}/mcp`, authorization_servers: [issuer] }));
		} else if (pathname.startsWith("/.well-known/oauth-authorization-server")) {
			response.end(
				JSON.stringify({
					issuer,
					authorization_endpoint: `${issuer}/authorize`,
					token_endpoint: `${issuer}/token`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
				}),
			);
		} else if (pathname === "/token") {
			for await (const _chunk of request) {
			}
			response.end(JSON.stringify({ access_token: "issued-for-test", token_type: "Bearer", expires_in: 3600 }));
		} else response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	issuer = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
	const root = mkdtempSync(join(tmpdir(), "candy-mcp-login-"));
	try {
		const store = new McpOAuthStore(root);
		await loginToMcpServer(
			"fixture",
			{ url: `${issuer}/mcp`, oauth: { clientId: "candy-test" } },
			store,
			async (interaction) => {
				if (interaction.type !== "authorization") throw new Error("Expected authorization URL");
				const authorization = new URL(interaction.url);
				const redirect = new URL(authorization.searchParams.get("redirect_uri")!);
				redirect.searchParams.set("code", "synthetic-code");
				redirect.searchParams.set("state", authorization.searchParams.get("state")!);
				redirect.searchParams.set("iss", issuer);
				const callback = await fetch(redirect);
				expect(callback.status).toBe(200);
				return { action: "accept" };
			},
		);
		expect(new McpOAuthStore(root).accessToken("fixture", `${issuer}/mcp`)).toBe("issued-for-test");
	} finally {
		await new Promise<void>((resolve) => http.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});
