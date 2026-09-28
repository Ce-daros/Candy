/**
 * Reload Runtime Extension
 *
 * Demonstrates ctx.reload() from ExtensionCommandContext. The tool explains
 * how to run the command after the current turn.
 */

import type { ExtensionAPI } from "@candy/coding-agent";
import { Type } from "typebox";

export default function (candy: ExtensionAPI) {
	// Command entrypoint for reload.
	// Treat reload as terminal for this handler.
	candy.registerCommand("reload-runtime", {
		description: "Reload extensions, skills, prompts, themes, and context files",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});

	// Tools run during an agent turn. Reload is available from the Command entry when idle.
	candy.registerTool({
		name: "reload_runtime",
		label: "Reload Runtime",
		description: "Explain how to reload extensions, skills, prompts, themes, and context files",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [
					{
						type: "text",
						text: "Reload requires an idle session. Choose reload-runtime in Command after this turn.",
					},
				],
				details: {},
				isError: true,
			};
		},
	});
}
