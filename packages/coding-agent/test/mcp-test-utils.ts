import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPackageDir } from "../src/config.ts";
import { McpRuntime } from "../src/core/mcp/runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/** Real stdio MCP records, shared by session and interactive smoke fixtures. */
export async function createFixtureMcp() {
	const root = mkdtempSync(join(tmpdir(), "candy-codemode-fixture-"));
	const config = {
		mcpServers: {
			fixture: {
				command: process.execPath,
				args: [join(getPackageDir(), "test", "fixtures", "mcp", "acceptance-server.mjs")],
			},
		},
	};
	writeFileSync(join(root, "mcp.json"), JSON.stringify(config));
	const runtime = await McpRuntime.create({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory() });
	return {
		runtime,
		config,
		async cleanup() {
			await runtime.dispose();
			rmSync(root, { recursive: true });
		},
	};
}
