import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { resolveConfigValue } from "../resolve-config-value.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { McpConfigFile, McpConfigScope, McpExposure, McpServerConfig } from "./types.ts";

export interface McpConfigPaths {
	global: string;
	project: string;
}

export function getMcpConfigPaths(cwd: string, agentDir: string): McpConfigPaths {
	return { global: join(agentDir, "mcp.json"), project: join(cwd, CONFIG_DIR_NAME, "mcp.json") };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseServer(name: string, value: unknown): McpServerConfig {
	if (!isObject(value)) throw new Error(`MCP server ${name}: expected an object`);
	const server = value as McpServerConfig;
	if ((server.command === undefined) === (server.url === undefined)) {
		// A project entry with only presentation overrides is resolved after merging.
		if (
			server.command !== undefined ||
			server.url !== undefined ||
			Object.keys(value).some((key) => !["enabled", "exposure"].includes(key))
		) {
			throw new Error(`MCP server ${name}: specify exactly one of command or url`);
		}
	}
	if (server.command !== undefined && typeof server.command !== "string")
		throw new Error(`MCP server ${name}: command must be a string`);
	if (server.url !== undefined && typeof server.url !== "string")
		throw new Error(`MCP server ${name}: url must be a string`);
	if (
		server.args !== undefined &&
		(!Array.isArray(server.args) || !server.args.every((arg) => typeof arg === "string"))
	)
		throw new Error(`MCP server ${name}: args must be strings`);
	if (server.enabled !== undefined && typeof server.enabled !== "boolean")
		throw new Error(`MCP server ${name}: enabled must be a boolean`);
	if (server.exposure !== undefined && !["direct", "codemode", "hidden"].includes(server.exposure))
		throw new Error(`MCP server ${name}: invalid exposure`);
	for (const key of ["env", "headers"] as const) {
		const values = server[key];
		if (
			values !== undefined &&
			(!isObject(values) || !Object.values(values).every((entry) => typeof entry === "string"))
		)
			throw new Error(`MCP server ${name}: ${key} must contain strings`);
	}
	return server;
}

export function readMcpConfig(path: string): McpConfigFile {
	if (!existsSync(path)) return { mcpServers: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Failed to read MCP config ${path}: ${String(error)}`);
	}
	if (!isObject(parsed) || !isObject(parsed.mcpServers))
		throw new Error(`MCP config ${path}: expected mcpServers object`);
	const mcpServers: Record<string, McpServerConfig> = {};
	for (const [name, value] of Object.entries(parsed.mcpServers)) mcpServers[name] = parseServer(name, value);
	return { mcpServers };
}

export function loadMcpConfig(paths: McpConfigPaths, settingsManager: SettingsManager): McpConfigFile {
	const global = readMcpConfig(paths.global);
	if (!settingsManager.isProjectTrusted()) return global;
	const project = readMcpConfig(paths.project);
	const mcpServers = { ...global.mcpServers };
	for (const [name, value] of Object.entries(project.mcpServers)) {
		const previous = mcpServers[name];
		mcpServers[name] = previous && !value.command && !value.url ? { ...previous, ...value } : value;
	}
	for (const [name, value] of Object.entries(mcpServers)) {
		if ((value.command === undefined) === (value.url === undefined))
			throw new Error(`MCP server ${name}: specify exactly one of command or url`);
	}
	return { mcpServers };
}

export function writeMcpServerSetting(
	paths: McpConfigPaths,
	settingsManager: SettingsManager,
	name: string,
	setting: "enabled" | "exposure",
	value: boolean | McpExposure,
	scope: McpConfigScope = "global",
): void {
	if (scope === "project" && !settingsManager.isProjectTrusted())
		throw new Error("Project is not trusted; refusing to write MCP configuration");
	const path = paths[scope];
	const config = readMcpConfig(path);
	config.mcpServers[name] = { ...config.mcpServers[name], [setting]: value };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function resolveMap(
	values: Record<string, string> | undefined,
	env?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
	if (!values) return undefined;
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		const resolved = await resolveConfigValue(value, env);
		if (resolved === undefined) throw new Error(`Missing environment variable for MCP configuration value ${key}`);
		result[key] = resolved;
	}
	return result;
}

export async function resolveMcpServerConfig(config: McpServerConfig, cwd: string): Promise<McpServerConfig> {
	const env = await resolveMap(config.env);
	const headers = await resolveMap(config.headers, env);
	const resolvedCwd = config.cwd ? await resolveConfigValue(config.cwd, env) : undefined;
	const url = config.url ? await resolveConfigValue(config.url, env) : undefined;
	const command = config.command ? await resolveConfigValue(config.command, env) : undefined;
	const args = config.args
		? await Promise.all(
				config.args.map(async (arg) => {
					const value = await resolveConfigValue(arg, env);
					if (value === undefined) throw new Error("Missing environment variable in MCP command arguments");
					return value;
				}),
			)
		: undefined;
	if (config.url && !url) throw new Error("Missing environment variable in MCP URL");
	if (config.command && !command) throw new Error("Missing environment variable in MCP command");
	return {
		...config,
		...(env ? { env } : {}),
		...(headers ? { headers } : {}),
		...(resolvedCwd ? { cwd: isAbsolute(resolvedCwd) ? resolvedCwd : resolve(cwd, resolvedCwd) } : {}),
		...(url ? { url } : {}),
		...(command ? { command } : {}),
		...(args ? { args } : {}),
	};
}
