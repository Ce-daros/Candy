/** Candy's host integration for the upstream QuickJS codemode sandbox. */
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolCallOutcome, AgentToolResult } from "@candy/agent-core";
import {
	type CodemodeResult,
	CodemodeSandbox,
	type CodemodeStoreWrites,
	type CodemodeTool,
	type CodemodeWasmModule,
	parseCodemodeSource,
} from "@candy/codemode";
import { CODEMODE_SOURCE_GRAMMAR } from "@candy/codemode/source";
import { Type } from "typebox";
import type { ToolDefinition } from "./extensions/types.ts";
import type { SessionEntry } from "./session-records.ts";

export const CODEMODE_STORE_ENTRY_TYPE = "codemode-store";
export const CODEMODE_ENABLED_ENTRY_TYPE = "codemode-enabled";
const CODEMODE_TOOL_NAME = "codemode";
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const MAX_PREVIEW_CHARS = 200;
const codemodeSchema = Type.Object({ code: Type.String({ description: "JavaScript async function body" }) });

export interface CodemodeEnabledEntryData {
	enabled: boolean;
}

export function readCodemodeEnabled(branch: readonly SessionEntry[]): boolean | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "custom" && entry.customType === CODEMODE_ENABLED_ENTRY_TYPE) {
			return (entry.data as CodemodeEnabledEntryData).enabled;
		}
	}
	return undefined;
}

export interface CodemodeNestedCall {
	id: string;
	name: string;
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	error?: string;
}

export interface CodemodeToolDetails {
	calls: CodemodeNestedCall[];
	fullOutputPath?: string;
}

export interface CodemodeToolOptions {
	/** Enabled MCP tools configured for codemode exposure at the time this script runs. */
	getTools(): readonly AgentTool[];
	executeTool(
		name: string,
		args: unknown,
		options: { signal: AbortSignal; parentToolCallId: string },
	): Promise<AgentToolCallOutcome>;
	getBranch(): readonly SessionEntry[];
	appendEntry(customType: string, data: CodemodeStoreWrites): void;
	wasm?: CodemodeWasmModule | Promise<CodemodeWasmModule>;
	workerUrl?: string | URL;
}

function readStore(branch: readonly SessionEntry[]): Record<string, unknown> {
	const values = new Map<string, unknown>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== CODEMODE_STORE_ENTRY_TYPE) continue;
		const data = entry.data as CodemodeStoreWrites;
		for (const key of data.delete) values.delete(key);
		for (const [key, value] of Object.entries(data.set)) values.set(key, value);
	}
	return Object.fromEntries(values);
}

function textOf(result: AgentToolResult): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function scriptValue(tool: AgentTool, outcome: AgentToolCallOutcome): unknown {
	if (tool.outputSchema && outcome.result.structuredContent !== undefined) return outcome.result.structuredContent;
	const value = textOf(outcome.result);
	if (outcome.isError) throw new Error(value || `Tool ${tool.name} failed`);
	return value;
}

function preview(value: unknown): string {
	const json = JSON.stringify(value) ?? String(value);
	return json.length > MAX_PREVIEW_CHARS ? `${json.slice(0, MAX_PREVIEW_CHARS)}…` : json;
}

export function createCodemodeToolDefinition(
	options: CodemodeToolOptions,
): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails> {
	return {
		name: CODEMODE_TOOL_NAME,
		label: "Codemode",
		description: `Execute MCP calls and process their results using a JavaScript async function body. First use the separate search_mcp_tools tool to get declarations for unfamiliar MCP tools. Call the returned names as await tools.<name>(args). Only enabled MCP tools configured for codemode exposure are callable; builtin tools, ordinary extension/SDK tools, and direct or hidden MCP tools are unavailable here. Batch or chain MCP calls and filter, sort, or aggregate their results before showing relevant output. Use bash for standalone calculations and local data processing. Top-level await and return work. Use text(value) or image(dataUrlOrImageBlock) to show output; a returned value is also shown, but a bare expression produces no output. Each execution has fresh variables. Do not redeclare sandbox globals such as tools, text, image, store, or load. store(key, value) and load(key) keep JSON values on this session branch, committed only when the script succeeds. Calls still running when the script finishes are cancelled. The sandbox has no Node, file system, network, timers, or discovery functions. Optional first line: // @options: {"max_output_tokens": 10000, "timeout_ms": 60000}.`,
		promptSnippet: "Call MCP tools and process their results",
		promptGuidelines: [
			"Use search_mcp_tools to discover declarations before calling unfamiliar MCP tools through codemode.",
			"Use codemode to batch or chain MCP calls and filter, sort, or aggregate their results when it saves context. Use bash for standalone calculations and local data processing.",
		],
		parameters: codemodeSchema,
		constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		execute: async (toolCallId, { code }, signal, onUpdate) => {
			const parsed = parseCodemodeSource(code);
			const tools = options.getTools();
			const calls: CodemodeNestedCall[] = [];
			const details = (): CodemodeToolDetails => ({ calls: calls.map((call) => ({ ...call })) });
			const publish = () => onUpdate?.({ content: [], details: details() });
			let callIndex = 0;
			const sandboxTools: CodemodeTool[] = tools.map((tool) => ({
				name: tool.name,
				execute: async (args, { signal: nestedSignal }) => {
					const record: CodemodeNestedCall = {
						id: `${toolCallId}/${++callIndex}`,
						name: tool.name,
						args: preview(args),
						status: "running",
					};
					calls.push(record);
					publish();
					const started = performance.now();
					try {
						const outcome = await options.executeTool(tool.name, args, {
							signal: nestedSignal,
							parentToolCallId: toolCallId,
						});
						record.id = outcome.toolCall.id;
						record.status = nestedSignal.aborted ? "cancelled" : outcome.isError ? "error" : "ok";
						if (outcome.isError) record.error = preview(textOf(outcome.result));
						return scriptValue(tool, outcome);
					} catch (error) {
						record.status = nestedSignal.aborted ? "cancelled" : "error";
						record.error = preview(error instanceof Error ? error.message : String(error));
						throw error;
					} finally {
						record.durationMs = performance.now() - started;
						publish();
					}
				},
			}));
			const sandbox = new CodemodeSandbox({
				tools: sandboxTools,
				timeoutMs: parsed.options.timeoutMs ?? Number.POSITIVE_INFINITY,
				wasm: options.wasm,
				workerUrl: options.workerUrl,
			});
			let result: CodemodeResult;
			try {
				result = await sandbox.execute(parsed.code, { signal, store: readStore(options.getBranch()) });
			} finally {
				await sandbox.close();
			}
			for (const call of calls) if (call.status === "running") call.status = "cancelled";
			const content: AgentToolResult<CodemodeToolDetails>["content"] = result.output;
			if (result.ok) {
				const writes = result.storeWrites;
				if (Object.keys(writes.set).length > 0 || writes.delete.length > 0) {
					options.appendEntry(CODEMODE_STORE_ENTRY_TYPE, writes);
				}
				if (result.value !== undefined) {
					content.push({
						type: "text",
						text:
							typeof result.value === "string"
								? result.value
								: (JSON.stringify(result.value) ?? String(result.value)),
					});
				}
			} else {
				content.push({ type: "text", text: `Script error: ${result.error.stack ?? result.error.message}` });
			}
			const budget = (parsed.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) * 4;
			const texts = content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			const finalDetails = details();
			let finalContent = content;
			if (texts.length > budget) {
				const path = join(tmpdir(), `candy-codemode-${randomBytes(8).toString("hex")}.txt`);
				let outputNote: string;
				try {
					await writeFile(path, texts);
					finalDetails.fullOutputPath = path;
					outputNote = `full output: ${path}`;
				} catch (error) {
					outputNote = `could not save full output: ${error instanceof Error ? error.message : String(error)}`;
				}
				finalContent = [
					{ type: "text", text: `${texts.slice(0, budget)}\n[Output truncated; ${outputNote}]` },
					...content.filter((item) => item.type === "image"),
				];
			}
			return { content: finalContent, details: finalDetails, isError: !result.ok };
		},
	};
}
