import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const action of cleanup.splice(0).reverse()) await action();
});

async function createClient(mode: string): Promise<RpcClient> {
	const dir = mkdtempSync(join(tmpdir(), "candy-rpc-responses-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const cliPath = join(dir, "child.mjs");
	writeFileSync(
		cliPath,
		`
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line);
	const response = { type: "response", id: command.id, command: command.type };
	if (process.env.RPC_TEST_MODE === "started") {
		send({ type: "agent_start" });
		send({ type: "agent_settled" });
		send({ ...response, success: true, data: { disposition: "started" } });
	} else if (process.env.RPC_TEST_MODE === "handled") {
		send({ ...response, success: true, data: { disposition: "handled" } });
	} else if (process.env.RPC_TEST_MODE === "delayed") {
		setTimeout(() => send({ ...response, success: true, data: { disposition: "handled" } }), 80);
	} else send({ ...response, success: false, error: "rejected by server" });
});
`,
	);
	const client = new RpcClient({ cliPath, env: { RPC_TEST_MODE: mode } });
	await client.start();
	cleanup.push(() => client.stop());
	return client;
}

test("propagates failed responses from every void command", async () => {
	const client = await createClient("error");
	const commands = [
		() => client.abort(),
		() => client.commitSetting("global", "autocompact", true),
		() => client.clearSetting("global", "autocompact"),
		() => client.saveDefaultModel("faux", "test"),
		() => client.reloadResources(),
		() => client.reconnectMcpServer("test"),
		() => client.setMcpServerEnabled("test", true),
		() => client.setMcpServerExposure("test", "hidden"),
		() => client.loginMcpServer("test"),
		() => client.logoutMcpServer("test"),
		() => client.setThinkingLevel("off"),
		() => client.setSteeringMode("all"),
		() => client.setFollowUpMode("all"),
		() => client.setAutoCompaction(true),
		() => client.setAutoRetry(true),
		() => client.abortRetry(),
		() => client.abortBash(),
		() => client.setSessionName("test"),
	];
	for (const command of commands) await expect(command()).rejects.toThrow("rejected by server");
});

test("returns immediately for a handled prompt without a settled event", async () => {
	const client = await createClient("handled");
	await expect(client.promptAndWait("/handled", undefined, 100)).resolves.toEqual([]);
});

test("captures run events sent before the prompt acceptance response", async () => {
	const client = await createClient("started");
	await expect(client.promptAndWait("run", undefined, 100)).resolves.toEqual([
		{ type: "agent_start" },
		{ type: "agent_settled" },
	]);
});

test.each(["error", "delayed"])("cleans up event collection when %s rejects first", async (mode) => {
	const client = await createClient(mode);
	const subscribe = client.onEvent.bind(client);
	const unsubscribe = vi.fn<() => void>();
	vi.spyOn(client, "onEvent").mockImplementation((listener) => {
		unsubscribe.mockImplementation(subscribe(listener));
		return unsubscribe;
	});
	await expect(client.promptAndWait("run", undefined, 10)).rejects.toThrow(
		mode === "error" ? "rejected by server" : "Timeout collecting events",
	);
	expect(unsubscribe).toHaveBeenCalled();
	await new Promise((resolve) => setTimeout(resolve, 100));
});
