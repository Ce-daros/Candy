/**
 * Custom message rendering example.
 *
 * Shows how to use registerMessageRenderer to control how custom messages
 * appear in the TUI, with colors, formatting, and expandable details.
 *
 * Usage: open Command and choose `status`; enter an optional message to send it with custom rendering.
 */

import type { ExtensionAPI } from "@candy/coding-agent";
import { Box, Text } from "@candy/tui";

export default function (candy: ExtensionAPI) {
	// Register custom renderer for "status-update" messages
	candy.registerMessageRenderer("status-update", (message, { expanded, outputPad }, theme) => {
		const details = message.details as { level: string; timestamp: number } | undefined;
		const level = details?.level ?? "info";

		// Color based on level
		const color = level === "error" ? "error" : level === "warn" ? "warning" : "success";
		const prefix = theme.fg(color, `[${level.toUpperCase()}]`);

		let text = `${prefix} ${message.content}`;

		// Show timestamp when expanded
		if (expanded && details?.timestamp) {
			const time = new Date(details.timestamp).toLocaleTimeString();
			text += `\n${theme.fg("dim", `  at ${time}`)}`;
		}

		// Use Box with customMessageBg for consistent styling
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	// Command to send status messages
	candy.registerCommand("status", {
		description: "Send a status message; optionally prefix it with warn or error",
		handler: async (args, _ctx) => {
			const parts = args.trim().split(/\s+/);
			let level = "info";
			let content = args.trim();

			// Check for level prefix
			if (parts[0] === "warn" || parts[0] === "error") {
				level = parts[0];
				content = parts.slice(1).join(" ") || "Status update";
			}

			candy.sendMessage({
				customType: "status-update",
				content,
				display: true,
				details: { level, timestamp: Date.now() },
			});
		},
	});
}
