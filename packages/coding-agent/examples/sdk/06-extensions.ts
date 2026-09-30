/** Load extensions from disk and register one inline extension factory. */

import { createAgentSessionRuntime, SessionHistory } from "@candy/coding-agent";

const cwd = process.cwd();
const runtime = await createAgentSessionRuntime({
	cwd,
	sessionManager: SessionHistory.inMemory(cwd),
	resourceLoaderOptions: {
		additionalExtensionPaths: ["./my-logging-extension.ts", "./my-safety-extension.ts"],
		extensionFactories: [
			(candy) => {
				candy.on("agent_start", () => console.log("[Inline Extension] Agent starting"));
			},
		],
	},
});

try {
	const session = runtime.session;
	session.execution.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});
	await session.execution.prompt("List files in the current directory.");
	console.log();
} finally {
	await runtime.dispose();
}

// Example extension file (./my-logging-extension.ts):
/*
import type { ExtensionAPI } from "@candy/coding-agent";

export default function (candy: ExtensionAPI) {
	candy.on("agent_start", () => console.log("[Extension] Agent starting"));
	candy.on("tool_call", (event) => {
		console.log(`[Extension] Tool: ${event.toolName}`);
		return undefined;
	});
	candy.on("agent_end", (event) => {
		console.log(`[Extension] Low-level run ended, ${event.messages.length} messages`);
	});
	candy.registerCommand("mycommand", {
		description: "Do something",
		handler: async (args, ctx) => ctx.ui.notify(`Command executed with: ${args}`),
	});
}
*/
