import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { getMcpConfigPaths, loadMcpConfig } from "../src/core/mcp/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { hasTrustRequiringProjectResources } from "../src/core/trust-manager.ts";

test("reads project MCP configuration only after project trust", () => {
	const root = mkdtempSync(join(tmpdir(), "candy-mcp-config-"));
	try {
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".candy"), { recursive: true });
		mkdirSync(agentDir);
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					global: { command: "global-command" },
					shared: { command: "global-shared", exposure: "direct" },
				},
			}),
		);
		writeFileSync(
			join(cwd, ".candy", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					shared: { enabled: false, exposure: "codemode" },
					project: { command: "project-command" },
				},
			}),
		);
		const paths = getMcpConfigPaths(cwd, agentDir);
		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		const untrusted = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		expect(loadMcpConfig(paths, untrusted).mcpServers).toEqual({
			global: { command: "global-command" },
			shared: { command: "global-shared", exposure: "direct" },
		});
		const trusted = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		expect(loadMcpConfig(paths, trusted).mcpServers).toEqual({
			global: { command: "global-command" },
			shared: { command: "global-shared", enabled: false, exposure: "codemode" },
			project: { command: "project-command" },
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
