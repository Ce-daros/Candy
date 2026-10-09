import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@candy/ai";
import { type CodemodeJsonSchema, renderToolSample } from "@candy/codemode";
import { acceptedContent, createMcpHandler, inputRequired, McpServer, Server } from "@modelcontextprotocol/server";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod/v4";
import * as mcpOAuth from "../src/core/mcp/oauth.ts";
import { mcpToolResult } from "../src/core/mcp/result.ts";
import { McpRuntime } from "../src/core/mcp/runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHarness } from "./suite/harness.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const action of cleanup.splice(0).reverse()) await action();
});

async function startHttpHandler(handler: ReturnType<typeof createMcpHandler>): Promise<string> {
	const http = createServer(async (request, response) => {
		const parts: Buffer[] = [];
		for await (const chunk of request) parts.push(Buffer.from(chunk));
		const url = `http://127.0.0.1:${(http.address() as { port: number }).port}${request.url}`;
		const webRequest = new Request(url, {
			method: request.method,
			headers: Object.entries(request.headers).flatMap(([key, value]) =>
				value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]],
			),
			...(parts.length ? { body: Buffer.concat(parts) } : {}),
		});
		const result = await handler.fetch(webRequest);
		response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
		if (result.body) Readable.fromWeb(result.body).pipe(response);
		else response.end();
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	cleanup.push(async () => {
		await handler.close();
		await new Promise<void>((resolve) => http.close(() => resolve()));
	});
	return `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
}

test("connects to a resource-only server without requesting a tool catalog", async () => {
	const handler = createMcpHandler(() => {
		const server = new Server({ name: "resources", version: "1.0.0" }, { capabilities: { resources: {} } });
		server.setRequestHandler("resources/list", async (request) =>
			request.params?.cursor
				? { resources: [{ name: "second", uri: "fixture://second" }] }
				: { resources: [{ name: "first", uri: "fixture://first" }], nextCursor: "next" },
		);
		server.setRequestHandler("resources/templates/list", async () => ({
			resourceTemplates: [{ name: "record", uriTemplate: "fixture://{id}" }],
		}));
		server.setRequestHandler("resources/read", async ({ params }) => ({
			contents: [{ uri: params.uri, text: "resource only" }],
		}));
		return server;
	});
	const url = await startHttpHandler(handler);
	const root = mkdtempSync(join(tmpdir(), "candy-mcp-resources-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { resources: { url } } }));
	const runtime = await McpRuntime.create({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
	cleanup.push(() => runtime.dispose());
	expect(runtime.list()[0]).toMatchObject({ status: "connected", toolsCount: 0, protocolVersion: "2026-07-28" });
	const tools = runtime.getTools();
	expect(tools.map(({ name }) => name)).toEqual([
		"list_mcp_resources",
		"list_mcp_resource_templates",
		"read_mcp_resource",
	]);
	// Progressive declarations must tell the model which resource-only server it can address.
	expect(renderToolSample({ name: tools[0].name, inputSchema: tools[0].parameters as CodemodeJsonSchema })).toContain(
		'server: "resources"',
	);
	const listed = await tools[0].execute("list", { server: "resources" }, undefined, undefined, undefined!);
	expect(listed.structuredContent).toEqual({
		resources: [
			{ name: "first", uri: "fixture://first" },
			{ name: "second", uri: "fixture://second" },
		],
	});
	const templates = await tools[1].execute("templates", { server: "resources" }, undefined, undefined, undefined!);
	expect(templates.structuredContent).toEqual({
		resourceTemplates: [{ name: "record", uriTemplate: "fixture://{id}" }],
	});
	const read = await tools[2].execute(
		"read",
		{ server: "resources", uri: "fixture://first" },
		undefined,
		undefined,
		undefined!,
	);
	expect(read.content).toEqual([{ type: "text", text: "fixture://first\nresource only" }]);
});

test("connects to a modern HTTP server and calls its tools and resources", async () => {
	let lookupName = "lookup";
	const handler = createMcpHandler(() => {
		const server = new McpServer({ name: "fixture", version: "1.0.0" });
		server.registerTool(
			lookupName,
			{ description: "Look up a number", inputSchema: z.object({ value: z.number() }) },
			async ({ value }) => ({
				content: [{ type: "text", text: String(value * 2) }],
				structuredContent: { doubled: value * 2 },
			}),
		);
		server.registerTool(
			"confirm",
			{ description: "Ask for a confirmation", inputSchema: z.object({}) },
			async (_args, ctx) => {
				const schema = z.object({ agreed: z.boolean() });
				const answer = acceptedContent(ctx.mcpReq.inputResponses, "answer", schema);
				if (!answer)
					return inputRequired({
						inputRequests: { answer: inputRequired.elicit({ message: "Proceed?", requestedSchema: schema }) },
					});
				return { content: [{ type: "text", text: answer.agreed ? "accepted" : "rejected" }] };
			},
		);
		server.registerTool(
			"business_error",
			{ inputSchema: z.object({}), outputSchema: z.object({ value: z.number() }) },
			async () => ({
				content: [{ type: "text", text: "Record not found" }],
				structuredContent: { reason: "not-found" },
				isError: true,
			}),
		);
		server.registerResource("example", "fixture://example", { mimeType: "text/plain" }, async (uri) => ({
			contents: [{ uri: uri.href, text: "resource body" }],
		}));
		return server;
	});
	const url = await startHttpHandler(handler);
	const root = mkdtempSync(join(tmpdir(), "candy-mcp-runtime-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url } } }));
	const runtime = await McpRuntime.create({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
	cleanup.push(() => runtime.dispose());
	expect(runtime.list()[0]).toMatchObject({
		name: "fixture",
		status: "connected",
		protocolVersion: "2026-07-28",
		toolsCount: 3,
	});
	const tool = runtime.getTools().find((candidate) => candidate.name === "mcp_fixture_lookup");
	expect(tool).toBeDefined();
	const result = await tool!.execute("call", { value: 5 }, undefined, undefined, undefined!);
	expect(result.structuredContent).toMatchObject({
		content: [{ type: "text", text: "10" }],
		structuredContent: { doubled: 10 },
	});
	const resources = runtime.getTools().find((candidate) => candidate.name === "read_mcp_resource")!;
	const resource = await resources.execute(
		"resource",
		{ server: "fixture", uri: "fixture://example" },
		undefined,
		undefined,
		undefined!,
	);
	expect(resource.content[0]).toMatchObject({ text: "fixture://example\nresource body" });
	const businessError = runtime.getTools().find((candidate) => candidate.name === "mcp_fixture_business_error")!;
	const harness = await createHarness({ mcp: runtime });
	cleanup.push(() => harness.cleanup());
	harness.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: 'const r = await tools.mcp_fixture_business_error({}); if (!r.isError) throw Error("Expected business error"); text(r.structuredContent.reason);',
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Handled business error"),
	]);
	await harness.session.execution.prompt("Handle the missing record");
	expect(harness.session.execution.messages.filter((entry) => entry.role === "toolResult").at(-1)).toMatchObject({
		content: [{ type: "text", text: "not-found" }],
		isError: false,
	});
	expect(
		harness.eventsOfType("tool_execution_end").find((event) => event.toolName === businessError.name),
	).toMatchObject({
		isError: true,
		result: { structuredContent: { isError: true, structuredContent: { reason: "not-found" } } },
	});
	await runtime.setInteraction(async (interaction) => {
		const { type } = interaction;
		if (type !== "elicitation") throw new Error("Expected elicitation");
		expect(interaction.request.mode).toBe("form");
		return { action: "accept", content: { agreed: true } };
	});
	expect(runtime.list()[0].status).toBe("connected");
	const confirm = runtime.getTools().find((candidate) => candidate.name === "mcp_fixture_confirm")!;
	const confirmed = await confirm.execute("confirm", {}, undefined, undefined, undefined!);
	expect(confirmed.content[0]).toMatchObject({ text: "accepted" });
	let entered: (() => void) | undefined;
	const elicitationEntered = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let inputSignal: AbortSignal | undefined;
	await runtime.setInteraction(async (_interaction, signal) => {
		inputSignal = signal;
		entered?.();
		return new Promise((_, reject) =>
			signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
		);
	});
	const controller = new AbortController();
	const cancelled = confirm.execute("cancel", {}, controller.signal, undefined, undefined!);
	await elicitationEntered;
	controller.abort();
	await expect(cancelled).rejects.toThrow();
	expect(inputSignal?.aborted).toBe(true);
	lookupName = "lookup_new";
	handler.notify.toolsChanged();
	await expect
		.poll(() => runtime.getTools().some((candidate) => candidate.name === "mcp_fixture_lookup_new"))
		.toBe(true);
});

test("does not start configured servers when tools are disabled", async () => {
	const root = mkdtempSync(join(tmpdir(), "candy-mcp-disabled-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, "mcp.json"),
		JSON.stringify({ mcpServers: { off: { command: "nonexistent-command" } } }),
	);
	const runtime = await McpRuntime.create({
		cwd,
		agentDir,
		settingsManager: SettingsManager.create(cwd, agentDir),
		enabled: false,
	});
	cleanup.push(() => runtime.dispose());
	expect(runtime.list()[0]).toMatchObject({ name: "off", status: "disabled" });
	expect(runtime.getTools()).toEqual([]);
});

test("reports an HTTP authorization requirement without opening a browser", async () => {
	const http = createServer((_request, response) => response.writeHead(401, { "www-authenticate": "Bearer" }).end());
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	cleanup.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
	const root = mkdtempSync(join(tmpdir(), "candy-mcp-auth-needed-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: { private: { url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp` } },
		}),
	);
	const runtime = await McpRuntime.create({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
	cleanup.push(() => runtime.dispose());
	expect(runtime.list()[0].status).toBe("needs-auth");
});

test("aggregates paginated tool catalogs using the SDK", async () => {
	const handler = createMcpHandler(() => {
		const server = new Server({ name: "pages", version: "1.0.0" }, { capabilities: { tools: {} } });
		server.setRequestHandler("tools/list", async (request) =>
			request.params?.cursor
				? { tools: [{ name: "second", inputSchema: { type: "object", properties: {} } }] }
				: { tools: [{ name: "first", inputSchema: { type: "object", properties: {} } }], nextCursor: "next" },
		);
		return server;
	});
	const url = await startHttpHandler(handler);
	const root = mkdtempSync(join(tmpdir(), "candy-mcp-pages-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { pages: { url } } }));
	const runtime = await McpRuntime.create({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
	cleanup.push(() => runtime.dispose());
	expect(runtime.list()[0]).toMatchObject({ status: "connected", toolsCount: 2 });
	expect(runtime.getTools().map(({ name }) => name)).toContain("mcp_pages_second");
	expect(runtime.getTools().map(({ name }) => name)).not.toContain("list_mcp_resources");
});

test.each([
	{ legacy: false, protocolVersion: "2026-07-28" },
	{ legacy: true, protocolVersion: "2025-11-25" },
	{ legacy: false, protocolVersion: "2026-07-28", stderrBytes: 8 * 1024 * 1024 },
])(
	"negotiates $protocolVersion over stdio ($stderrBytes stderr bytes)",
	async ({ legacy, protocolVersion, stderrBytes }) => {
		const root = mkdtempSync(join(tmpdir(), "candy-mcp-stdio-"));
		cleanup.push(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		const fixture = fileURLToPath(new URL("./fixtures/mcp/stdio-server.mjs", import.meta.url));
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					fixture: {
						command: process.execPath,
						args: [fixture],
						env: { MCP_FIXTURE_LEGACY: legacy ? "1" : "0", MCP_FIXTURE_STDERR_BYTES: String(stderrBytes ?? 0) },
					},
				},
			}),
		);
		const runtime = await McpRuntime.create({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir),
		});
		cleanup.push(() => runtime.dispose());
		expect(runtime.list()[0]).toMatchObject({ status: "connected", protocolVersion, toolsCount: 1 });
		const tool = runtime.getTools().find((candidate) => candidate.name === "mcp_fixture_echo")!;
		const result = await tool.execute("echo", { value: "hello" }, undefined, undefined, undefined!);
		expect(result.content[0]).toMatchObject({ type: "text", text: "hello" });
	},
);

test("keeps the HTTP server available for login after installing interaction", async () => {
	const root = mkdtempSync(join(tmpdir(), "candy-mcp-login-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { private: { url: "http://127.0.0.1/mcp" } } }));
	const runtime = await McpRuntime.create({
		cwd: root,
		agentDir: root,
		settingsManager: SettingsManager.inMemory(),
		enabled: false,
	});
	cleanup.push(() => runtime.dispose());
	const login = vi.spyOn(mcpOAuth, "loginToMcpServer").mockResolvedValue(undefined);
	cleanup.push(() => login.mockRestore());
	await runtime.setInteraction(async () => ({ action: "accept" }));
	await runtime.login("private");
	expect(login).toHaveBeenCalledOnce();
	expect(login.mock.calls[0][0]).toBe("private");
	expect(runtime.list()).toMatchObject([{ name: "private", status: "disabled" }]);
});

test("returns a saved audio file path with the original MCP result", async () => {
	const data = Buffer.from("synthetic audio");
	const result = await mcpToolResult({
		content: [{ type: "audio", data: data.toString("base64"), mimeType: "audio/mpeg", _meta: { secret: "private" } }],
		_meta: { secret: "private" },
	});
	const structured = result.structuredContent as {
		content: Array<Record<string, unknown>>;
		files: Array<{ path: string; mimeType: string }>;
	};
	expect(structured.files[0].mimeType).toBe("audio/mpeg");
	expect(readFileSync(structured.files[0].path)).toEqual(data);
	expect(structured.content[0].data).toBe(data.toString("base64"));
	expect(structured.content[0]).not.toHaveProperty("_meta");
	expect(structured).not.toHaveProperty("_meta");
	cleanup.push(() => rmSync(structured.files[0].path, { force: true }));
});
