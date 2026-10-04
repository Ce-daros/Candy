import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@candy/agent-core";
import type { JsonValue } from "@candy/ai";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/client";

function extensionFor(mimeType: string): string {
	const subtype = mimeType.split("/")[1]?.split(";")[0]?.toLowerCase();
	if (!subtype || !/^[a-z0-9.+-]+$/.test(subtype)) return "bin";
	return subtype === "mpeg" ? "mp3" : subtype === "x-wav" ? "wav" : subtype === "jpeg" ? "jpg" : subtype;
}

async function saveBinary(data: string, mimeType: string): Promise<string> {
	const directory = join(tmpdir(), "candy-mcp-media");
	await mkdir(directory, { recursive: true });
	const path = join(directory, `${randomUUID()}.${extensionFor(mimeType)}`);
	await writeFile(path, Buffer.from(data, "base64"));
	return path;
}

function withoutPrivateMeta<T extends object>(result: T): Omit<T, "_meta"> {
	const { _meta: _ignored, ...publicResult } = result as T & { _meta?: unknown };
	return publicResult;
}

interface SavedFile {
	path: string;
	mimeType: string;
	description?: string;
}

function publicToolResult(result: CallToolResult): Record<string, unknown> {
	const value = withoutPrivateMeta(result) as Record<string, unknown>;
	return {
		...value,
		content: result.content.map((block) =>
			block.type === "resource"
				? { ...withoutPrivateMeta(block), resource: withoutPrivateMeta(block.resource) }
				: withoutPrivateMeta(block),
		),
	};
}

async function appendResource(
	resource: ReadResourceResult["contents"][number],
	content: AgentToolResult["content"],
	files: SavedFile[],
): Promise<void> {
	if ("text" in resource) content.push({ type: "text", text: `${resource.uri}\n${resource.text}` });
	else {
		const mimeType = resource.mimeType ?? "application/octet-stream";
		const path = await saveBinary(resource.blob, mimeType);
		files.push({ path, mimeType, description: resource.uri });
		content.push({ type: "text", text: `${resource.uri}: ${path} (${mimeType})` });
	}
}

export async function mcpToolResult(result: CallToolResult): Promise<AgentToolResult> {
	const content: AgentToolResult["content"] = [];
	const files: SavedFile[] = [];
	for (const block of result.content) {
		if (block.type === "text") {
			content.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			content.push({ type: "image", data: block.data, mimeType: block.mimeType });
		} else if (block.type === "audio") {
			const path = await saveBinary(block.data, block.mimeType);
			files.push({ path, mimeType: block.mimeType, description: "Audio from MCP tool" });
			content.push({ type: "text", text: `Audio: ${path} (${block.mimeType})` });
		} else if (block.type === "resource_link") {
			content.push({ type: "text", text: `${block.name}: ${block.uri}` });
		} else if (block.type === "resource") {
			await appendResource(block.resource, content, files);
		}
	}
	if (content.length === 0 && result.structuredContent !== undefined) {
		content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
	}
	return {
		content,
		details: undefined,
		structuredContent: { ...publicToolResult(result), ...(files.length ? { files } : {}) },
		isError: result.isError ?? false,
	} as AgentToolResult;
}

export async function mcpResourceResult(result: ReadResourceResult): Promise<AgentToolResult> {
	const content: AgentToolResult["content"] = [];
	const files: SavedFile[] = [];
	for (const resource of result.contents) await appendResource(resource, content, files);
	const structuredContent = JSON.parse(
		JSON.stringify({
			...withoutPrivateMeta(result),
			contents: result.contents.map((resource) => withoutPrivateMeta(resource)),
			...(files.length ? { files } : {}),
		}),
	) as JsonValue;
	return {
		content,
		details: undefined,
		structuredContent,
	};
}
