/**
 * Commands Extension
 *
 * Demonstrates the candy.getCommands() API by providing a commands command
 * that lists all available commands in the current session.
 *
 * Usage:
 * 1. Copy this file to ~/.candy/agent/extensions/ or your project's .candy/extensions/
 * 2. Open Command and run commands to see available commands
 * 3. Pass extension, prompt, or skill to filter by source
 */

import type { CommandInfo, ExtensionAPI } from "@candy/coding-agent";

export default function commandsExtension(candy: ExtensionAPI) {
	candy.registerCommand("commands", {
		description: "List available commands",
		getArgumentCompletions: (prefix) => {
			const sources = ["extension", "prompt", "skill"];
			const filtered = sources.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const commands = candy.getCommands();
			const sourceFilter = args.trim() as "extension" | "prompt" | "skill" | "";

			// Filter by source if specified
			const filtered = sourceFilter ? commands.filter((c) => c.source === sourceFilter) : commands;

			if (filtered.length === 0) {
				ctx.ui.notify(sourceFilter ? `No ${sourceFilter} commands found` : "No commands found", "info");
				return;
			}

			// Build selection items grouped by source
			const formatCommand = (cmd: CommandInfo): string => {
				const desc = cmd.description ? ` - ${cmd.description}` : "";
				return `${cmd.name} (${cmd.source})${desc}`;
			};

			const items: string[] = [];
			const selectedCommands = new Map<string, CommandInfo>();
			const sources: Array<{ key: "extension" | "prompt" | "skill"; label: string }> = [
				{ key: "extension", label: "Extensions" },
				{ key: "prompt", label: "Prompts" },
				{ key: "skill", label: "Skills" },
			];

			for (const { key, label } of sources) {
				const cmds = filtered.filter((c) => c.source === key);
				if (cmds.length > 0) {
					items.push(`--- ${label} ---`);
					for (const cmd of cmds) {
						const item = formatCommand(cmd);
						items.push(item);
						selectedCommands.set(item, cmd);
					}
				}
			}

			// Show in a selector (user can scroll and see all commands)
			const selected = await ctx.ui.select("Available Commands", items);

			// If user selected a command (not a header), offer to show its path
			if (selected) {
				const cmd = selectedCommands.get(selected);
				if (cmd?.sourceInfo.path) {
					const showPath = await ctx.ui.confirm(cmd.name, `View source path?\n${cmd.sourceInfo.path}`);
					if (showPath) {
						ctx.ui.notify(cmd.sourceInfo.path, "info");
					}
				}
			}
		},
	});
}
