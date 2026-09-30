/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth storage and provider composition.
 */

import { getShellConfig } from "../utils/shell.ts";
import { execCommand } from "./exec.ts";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

type ConfigValueReference = { type: "command"; config: string } | { type: "template"; parts: TemplatePart[] };

function appendLiteral(parts: TemplatePart[], value: string): void {
	if (!value) return;
	const previousPart = parts[parts.length - 1];
	if (previousPart?.type === "literal") {
		previousPart.value += value;
		return;
	}
	parts.push({ type: "literal", value });
}

function parseConfigValueTemplate(config: string): TemplatePart[] {
	const parts: TemplatePart[] = [];
	let index = 0;

	while (index < config.length) {
		const dollarIndex = config.indexOf("$", index);
		if (dollarIndex < 0) {
			appendLiteral(parts, config.slice(index));
			break;
		}

		appendLiteral(parts, config.slice(index, dollarIndex));
		const nextChar = config[dollarIndex + 1];

		if (nextChar === "$" || nextChar === "!") {
			appendLiteral(parts, nextChar);
			index = dollarIndex + 2;
			continue;
		}

		if (nextChar === "{") {
			const endIndex = config.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				appendLiteral(parts, "$");
				index = dollarIndex + 1;
				continue;
			}

			const name = config.slice(dollarIndex + 2, endIndex);
			if (ENV_VAR_NAME_RE.test(name)) {
				parts.push({ type: "env", name });
			} else {
				appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
			}
			index = endIndex + 1;
			continue;
		}

		const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		if (match) {
			parts.push({ type: "env", name: match[0] });
			index = dollarIndex + 1 + match[0].length;
			continue;
		}

		appendLiteral(parts, "$");
		index = dollarIndex + 1;
	}

	return parts;
}

function parseConfigValueReference(config: string): ConfigValueReference {
	if (config.startsWith("!")) {
		return { type: "command", config };
	}

	return { type: "template", parts: parseConfigValueTemplate(config) };
}

function resolveEnvConfigValue(name: string, env?: Record<string, string>): string | undefined {
	return env?.[name] || process.env[name] || undefined;
}

function getTemplateEnvVarNames(parts: TemplatePart[]): string[] {
	const names: string[] = [];
	for (const part of parts) {
		if (part.type !== "env" || names.includes(part.name)) continue;
		names.push(part.name);
	}
	return names;
}

function resolveTemplate(parts: TemplatePart[], env?: Record<string, string>): string | undefined {
	let resolved = "";
	for (const part of parts) {
		if (part.type === "literal") {
			resolved += part.value;
			continue;
		}
		const envValue = resolveEnvConfigValue(part.name, env);
		if (envValue === undefined) return undefined;
		resolved += envValue;
	}
	return resolved;
}

export function getConfigValueEnvVarNames(config: string): string[] {
	const reference = parseConfigValueReference(config);
	return reference.type === "template" ? getTemplateEnvVarNames(reference.parts) : [];
}

export function getMissingConfigValueEnvVarNames(config: string, env?: Record<string, string>): string[] {
	return getConfigValueEnvVarNames(config).filter((name) => resolveEnvConfigValue(name, env) === undefined);
}

export function isCommandConfigValue(config: string): boolean {
	return parseConfigValueReference(config).type === "command";
}

export function isConfigValueConfigured(config: string, env?: Record<string, string>): boolean {
	return getMissingConfigValueEnvVarNames(config, env).length === 0;
}

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Interpolates "$ENV_VAR" or "${ENV_VAR}" references with the named environment variable
 * - In non-command values, "$$" escapes a literal "$" and "$!" escapes a literal "!"
 * - Otherwise treats the value as a literal
 */
export interface ConfigValueResolveOptions {
	signal?: AbortSignal;
	cache?: Map<string, string>;
}

export async function resolveConfigValue(
	config: string,
	env?: Record<string, string>,
	options: ConfigValueResolveOptions = {},
): Promise<string | undefined> {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommand(reference.config, options);
	}
	return resolveTemplate(reference.parts, env);
}

async function executeCommandUncached(
	commandConfig: string,
	options: ConfigValueResolveOptions,
): Promise<string | undefined> {
	const command = commandConfig.slice(1);
	options.signal?.throwIfAborted();
	const { shell, args, commandTransport } = getShellConfig();
	const result = await execCommand(shell, commandTransport === "stdin" ? args : [...args, command], process.cwd(), {
		signal: options.signal,
		timeout: 10000,
		input: commandTransport === "stdin" ? command : undefined,
	});
	options.signal?.throwIfAborted();
	if (result.killed) throw new Error(`Shell command was cancelled or timed out: ${command}`);
	if (result.code !== 0) throw new Error(`Shell command failed (${result.code}): ${result.stderr.trim() || command}`);
	return result.stdout.trim() || undefined;
}

async function executeCommand(commandConfig: string, options: ConfigValueResolveOptions): Promise<string | undefined> {
	const cached = options.cache?.get(commandConfig);
	if (cached !== undefined) return cached;
	const result = await executeCommandUncached(commandConfig, options);
	if (result !== undefined) options.cache?.set(commandConfig, result);
	return result;
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveConfigValueUncached(
	config: string,
	env?: Record<string, string>,
	options: Omit<ConfigValueResolveOptions, "cache"> = {},
): Promise<string | undefined> {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommandUncached(reference.config, options);
	}
	return Promise.resolve(resolveTemplate(reference.parts, env));
}

export async function resolveConfigValueOrThrow(
	config: string,
	description: string,
	env?: Record<string, string>,
	options: ConfigValueResolveOptions = {},
): Promise<string> {
	const resolvedValue = await resolveConfigValue(config, env, options);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}

	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		throw new Error(`Failed to resolve ${description} from shell command: ${reference.config.slice(1)}`);
	}

	if (reference.type === "template") {
		const missingEnvVars = getMissingConfigValueEnvVarNames(config, env);
		if (missingEnvVars.length === 1) {
			throw new Error(`Failed to resolve ${description} from environment variable: ${missingEnvVars[0]}`);
		}
		if (missingEnvVars.length > 1) {
			throw new Error(`Failed to resolve ${description} from environment variables: ${missingEnvVars.join(", ")}`);
		}
	}

	throw new Error(`Failed to resolve ${description}`);
}

export async function resolveHeadersOrThrow(
	headers: Record<string, string> | undefined,
	description: string,
	env?: Record<string, string>,
	options: ConfigValueResolveOptions = {},
): Promise<Record<string, string> | undefined> {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = await resolveConfigValueOrThrow(value, `${description} header "${key}"`, env, options);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(cache: Map<string, string>): void {
	cache.clear();
}
