/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   candy -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@candy/coding-agent";
import { createBashTool } from "@candy/coding-agent";

export default function (candy: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, CANDY_SPAWN_HOOK: "1" },
		}),
	});

	candy.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
