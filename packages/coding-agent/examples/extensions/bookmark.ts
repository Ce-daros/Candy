/**
 * Entry bookmarking example.
 *
 * Shows setLabel to mark entries for easy navigation in History's tree.
 * Labels appear in the tree view and help you find important points.
 *
 * Usage: open Command and choose `bookmark`; add a label as the argument.
 */

import type { ExtensionAPI } from "@candy/coding-agent";

export default function (candy: ExtensionAPI) {
	candy.registerCommand("bookmark", {
		description: "Bookmark last message with an optional label",
		handler: async (args, ctx) => {
			const label = args.trim() || `bookmark-${Date.now()}`;

			// Find the last assistant message entry
			const entries = ctx.sessionManager.getEntries();
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					candy.setLabel(entry.id, label);
					ctx.ui.notify(`Bookmarked as: ${label}`, "info");
					return;
				}
			}

			ctx.ui.notify("No assistant message to bookmark", "warning");
		},
	});

	// Remove bookmark
	candy.registerCommand("unbookmark", {
		description: "Remove bookmark from last labeled entry",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getEntries();
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				const label = ctx.sessionManager.getLabel(entry.id);
				if (label) {
					candy.setLabel(entry.id, undefined);
					ctx.ui.notify(`Removed bookmark: ${label}`, "info");
					return;
				}
			}
			ctx.ui.notify("No bookmarked entry found", "warning");
		},
	});
}
