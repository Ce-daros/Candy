import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import {
	type AuthProvider,
	auth,
	type OAuthClientProvider,
	type StoredOAuthClientInformation,
	type StoredOAuthTokens,
	UnauthorizedError,
} from "@modelcontextprotocol/client";
import { parseJsonFile, withLockedJsonFileSync } from "../storage/json-file.ts";
import type { McpInteractionHandler, McpServerConfig } from "./types.ts";

interface StoredCredentials {
	clientInformation?: StoredOAuthClientInformation;
	tokens?: StoredOAuthTokens;
}

type CredentialFile = Record<string, StoredCredentials>;

export class McpOAuthStore {
	private readonly path: string;

	constructor(agentDir: string) {
		this.path = join(agentDir, "mcp-auth.json");
	}

	private read(): CredentialFile {
		return withLockedJsonFileSync(this.path, (current) => ({
			result: parseJsonFile<CredentialFile>(current, this.path, () => ({})),
		}));
	}

	private modify(change: (data: CredentialFile) => void): void {
		withLockedJsonFileSync(
			this.path,
			(current) => {
				const data = parseJsonFile<CredentialFile>(current, this.path, () => ({}));
				change(data);
				return { result: undefined, next: `${JSON.stringify(data, null, 2)}\n` };
			},
			{ mode: 0o600 },
		);
	}

	private key(server: string, url: string, issuer: string): string {
		return JSON.stringify([server, url, issuer]);
	}

	get(server: string, url: string, issuer?: string): StoredCredentials | undefined {
		const data = this.read();
		if (issuer) return data[this.key(server, url, issuer)];
		const prefix = JSON.stringify([server, url]).slice(0, -1);
		const entries = Object.entries(data)
			.reverse()
			.filter(([key]) => key.startsWith(`${prefix},`));
		const entry = entries.find(([, credentials]) => credentials.tokens) ?? entries[0];
		return entry?.[1];
	}

	update(server: string, url: string, issuer: string, changes: StoredCredentials): void {
		this.modify((data) => {
			const key = this.key(server, url, issuer);
			const next = { ...data[key], ...changes };
			delete data[key];
			data[key] = next;
		});
	}

	accessToken(server: string, url: string): string | undefined {
		return this.get(server, url)?.tokens?.access_token;
	}

	remove(server: string, url: string): void {
		this.modify((data) => {
			for (const key of Object.keys(data)) {
				const parsed: unknown = JSON.parse(key);
				if (Array.isArray(parsed) && parsed[0] === server && parsed[1] === url) delete data[key];
			}
		});
	}
}

/** Shared credentials for refresh and explicit login; login overrides the interactive callbacks. */
function createMcpOAuthProvider(
	server: string,
	serverUrl: string,
	config: McpServerConfig,
	store: McpOAuthStore,
	redirectUrl: string,
): OAuthClientProvider {
	return {
		redirectUrl,
		...(config.oauth?.clientMetadataUrl ? { clientMetadataUrl: config.oauth.clientMetadataUrl } : {}),
		clientMetadata: { client_name: "Candy", redirect_uris: [redirectUrl] },
		clientInformation: (ctx) =>
			config.oauth?.clientId
				? ({ client_id: config.oauth.clientId, issuer: ctx?.issuer } as StoredOAuthClientInformation)
				: store.get(server, serverUrl, ctx?.issuer)?.clientInformation,
		saveClientInformation: (information, ctx) => {
			if (!ctx) throw new Error("OAuth issuer is missing for client registration");
			store.update(server, serverUrl, ctx.issuer, { clientInformation: information });
		},
		tokens: (ctx) => store.get(server, serverUrl, ctx?.issuer)?.tokens,
		saveTokens: (tokens, ctx) => {
			const issuer = ctx?.issuer ?? tokens.issuer;
			if (!issuer) throw new Error("OAuth issuer is missing for token storage");
			store.update(server, serverUrl, issuer, { tokens });
		},
		redirectToAuthorization: () => {
			throw new UnauthorizedError(`MCP server ${server} requires login`);
		},
		saveCodeVerifier: () => {},
		codeVerifier: () => {
			throw new Error("MCP authorization requires explicit login");
		},
	};
}

export function createMcpTransportAuthProvider(
	server: string,
	config: McpServerConfig,
	store: McpOAuthStore,
): AuthProvider {
	const serverUrl = config.url;
	if (!serverUrl) throw new Error(`MCP server ${server} has no HTTP URL`);
	return {
		token: async () => store.accessToken(server, serverUrl),
		onUnauthorized: async () => {
			if (!store.get(server, serverUrl)?.tokens?.refresh_token)
				throw new UnauthorizedError(`MCP server ${server} requires login`);
			const result = await auth(
				createMcpOAuthProvider(server, serverUrl, config, store, "http://127.0.0.1/callback"),
				{ serverUrl },
			);
			if (result !== "AUTHORIZED") throw new UnauthorizedError(`MCP server ${server} requires login`);
		},
	};
}

export async function loginToMcpServer(
	server: string,
	config: McpServerConfig,
	store: McpOAuthStore,
	interaction: McpInteractionHandler,
	signal?: AbortSignal,
): Promise<void> {
	const serverUrl = config.url;
	if (!serverUrl) throw new Error(`MCP server ${server} has no HTTP URL`);
	const state = randomUUID();
	let verifier: string | undefined;
	let redirectUrl = "";
	let expectedState: string = state;
	let callbackResolve: ((value: { code: string; iss?: string }) => void) | undefined;
	let callbackReject: ((reason: Error) => void) | undefined;
	const callback = new Promise<{ code: string; iss?: string }>((resolve, reject) => {
		callbackResolve = resolve;
		callbackReject = reject;
	});
	const listener = createServer((request, response) => {
		const url = new URL(request.url ?? "/", redirectUrl);
		if (url.pathname !== "/callback") {
			response.writeHead(404).end();
			return;
		}
		if (url.searchParams.get("state") !== expectedState) {
			response.writeHead(400).end("Authorization state mismatch");
			callbackReject?.(new Error("MCP authorization state mismatch"));
			return;
		}
		const code = url.searchParams.get("code");
		if (!code) {
			response.writeHead(400).end("Authorization code missing");
			callbackReject?.(new Error(url.searchParams.get("error") ?? "MCP authorization code missing"));
			return;
		}
		response
			.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
			.end("Candy MCP authorization complete. You can close this tab.");
		callbackResolve?.({ code, iss: url.searchParams.get("iss") ?? undefined });
	});
	await new Promise<void>((resolve, reject) => {
		listener.once("error", reject);
		listener.listen(0, "127.0.0.1", () => resolve());
	});
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("Cannot bind MCP authorization callback");
	redirectUrl = `http://127.0.0.1:${address.port}/callback`;
	const provider: OAuthClientProvider = {
		...createMcpOAuthProvider(server, serverUrl, config, store, redirectUrl),
		state: () => state,
		redirectToAuthorization: async (url) => {
			expectedState = url.searchParams.get("state") ?? state;
			const result = await interaction({ type: "authorization", server, url: String(url) }, signal);
			if (result.action !== "accept") throw new Error(`MCP authorization ${result.action}`);
		},
		saveCodeVerifier: (value) => {
			verifier = value;
		},
		codeVerifier: () => {
			if (!verifier) throw new Error("OAuth PKCE verifier is missing");
			return verifier;
		},
	};
	const abortHandler = () => callbackReject?.(new Error("MCP authorization cancelled"));
	signal?.addEventListener("abort", abortHandler, { once: true });
	try {
		const result = await auth(provider, { serverUrl, scope: config.oauth?.scope });
		if (result === "REDIRECT") {
			const { code, iss } = await callback;
			await auth(provider, { serverUrl, authorizationCode: code, iss, scope: config.oauth?.scope });
		}
	} finally {
		signal?.removeEventListener("abort", abortHandler);
		await new Promise<void>((resolve) => listener.close(() => resolve()));
	}
}
