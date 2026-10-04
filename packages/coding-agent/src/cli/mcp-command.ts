import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { getAgentDir } from "../config.ts";
import { getMcpConfigPaths, readMcpConfig } from "../core/mcp/config.ts";
import { McpRuntime } from "../core/mcp/runtime.ts";
import type { McpServerConfig } from "../core/mcp/types.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../core/trust-manager.ts";
import { openBrowser } from "../utils/open-browser.ts";

export async function runMcpCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "mcp") return false;
	const operation = args[1];
	if (!operation || operation === "help" || args.includes("--help")) {
		console.log(`Usage:
  candy mcp add <name> --url <url> [--client-id <id>] [--client-metadata-url <url>] [--project]
  candy mcp add <name> [--project] -- <command> [args...]
  candy mcp remove <name> [--project]
  candy mcp list [--json]
  candy mcp login <name>
  candy mcp logout <name>`);
		return true;
	}
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const trusted = !hasTrustRequiringProjectResources(cwd) || new ProjectTrustStore(agentDir).get(cwd) === true;
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
	const name = args[2];
	if (operation === "add" || operation === "remove") {
		if (!name || name.startsWith("--")) throw new Error(`MCP ${operation} requires a server name`);
		const project = args.includes("--project");
		const paths = getMcpConfigPaths(cwd, agentDir);
		const path = project ? paths.project : paths.global;
		const config = readMcpConfig(path);
		if (operation === "remove") {
			if (!config.mcpServers[name]) throw new Error(`MCP server ${name} is not configured in ${path}`);
			delete config.mcpServers[name];
		} else {
			const value = (flag: string) => {
				const index = args.indexOf(flag);
				if (index < 0) return undefined;
				if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${flag} requires a value`);
				return args[index + 1];
			};
			const url = value("--url");
			const separator = args.indexOf("--");
			const command = separator < 0 ? undefined : args[separator + 1];
			if ((url === undefined) === (command === undefined))
				throw new Error("Specify --url or -- <command> [args...]");
			const server: McpServerConfig = url ? { url } : { command, args: args.slice(separator + 2) };
			const clientId = value("--client-id");
			const clientMetadataUrl = value("--client-metadata-url");
			if (clientId || clientMetadataUrl) server.oauth = { clientId, clientMetadataUrl };
			config.mcpServers[name] = server;
		}
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
		console.log(`${operation === "add" ? "Saved" : "Removed"} MCP server ${name} in ${path}`);
		return true;
	}
	if (!["list", "login", "logout"].includes(operation)) throw new Error(`Unknown MCP command ${operation}`);
	const runtime = await McpRuntime.create({ cwd, agentDir, settingsManager });
	try {
		if (operation === "list") {
			const servers = runtime.list();
			if (args.includes("--json")) console.log(JSON.stringify(servers, null, 2));
			else if (!servers.length) console.log("No MCP servers configured");
			else
				for (const server of servers)
					console.log(
						`${server.name}: ${server.status}, ${server.exposure}, protocol ${server.protocolVersion ?? "unavailable"}, ${server.toolsCount} tools${server.error ? ` — ${server.error}` : ""}`,
					);
		} else {
			if (!name) throw new Error(`MCP ${operation} requires a server name`);
			if (operation === "login") {
				if (!process.stdin.isTTY) throw new Error("MCP login requires an interactive terminal");
				const input = createInterface({ input: process.stdin, output: process.stdout });
				try {
					runtime.setInteraction(async (request, signal) => {
						if (request.type !== "authorization")
							throw new Error("MCP elicitation is unavailable in the login command");
						const answer = await input.question(`Open ${request.url} to authorize ${request.server}? [y/N] `, {
							signal,
						});
						if (answer.toLowerCase() !== "y") return { action: "decline" };
						openBrowser(request.url);
						return { action: "accept" };
					});
					await runtime.login(name);
				} finally {
					input.close();
				}
			} else await runtime.logout(name);
			console.log(`${operation === "login" ? "Logged in to" : "Logged out of"} ${name}`);
		}
	} finally {
		await runtime.dispose();
	}
	return true;
}
