/**
 * Session naming example.
 *
 * Shows setSessionName/getSessionName to give sessions friendly names
 * that appear in the session selector instead of the first message.
 *
 * Usage: open Command and choose `session-name`; add a name to set it or leave it empty to show it.
 */

import type { ExtensionAPI } from "@candy/coding-agent";

export default function (candy: ExtensionAPI) {
	candy.registerCommand("session-name", {
		description: "Set or show the session name",
		handler: async (args, ctx) => {
			const name = args.trim();

			if (name) {
				candy.setSessionName(name);
				ctx.ui.notify(`Session named: ${name}`, "info");
			} else {
				const current = candy.getSessionName();
				ctx.ui.notify(current ? `Session: ${current}` : "No session name set", "info");
			}
		},
	});
}
