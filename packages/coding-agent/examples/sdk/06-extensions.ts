import { resourceThemeAdapter } from "@candy/coding-agent";
import { extensionHostModules } from "@candy/coding-agent/extension-host-modules";
/**
 * Extensions Configuration
 *
 * Extensions intercept agent events and can register custom tools.
 * They provide a unified system for extensions, custom tools, commands, and more.
 *
 * By default, extension files are discovered from:
 * - ~/.candy/agent/extensions/
 * - <cwd>/.candy/extensions/
 * - Paths specified in settings.json "extensions" array
 *
 * An extension is a TypeScript file that exports a default function:
 *   export default function (candy: ExtensionAPI) { ... }
 */

import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@candy/coding-agent";

// Extensions are discovered automatically from standard locations.
// You can also add paths via settings.json or DefaultResourceLoader options.

const resourceLoader = new DefaultResourceLoader({
	extensionModules: extensionHostModules,
	themeAdapter: resourceThemeAdapter,
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	additionalExtensionPaths: ["./my-logging-extension.ts", "./my-safety-extension.ts"],
	extensionFactories: [
		(candy) => {
			candy.on("agent_start", () => {
				console.log("[Inline Extension] Agent starting");
			});
		},
	],
});
await resourceLoader.reload();

const { session } = await createAgentSession({
	resourceLoader,
	sessionManager: SessionManager.inMemory(),
});

try {
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await session.prompt("List files in the current directory.");
	console.log();
} finally {
	session.dispose();
}

// Example extension file (./my-logging-extension.ts):
/*
import type { ExtensionAPI } from "@candy/coding-agent";

export default function (candy: ExtensionAPI) {
	candy.on("agent_start", async () => {
		console.log("[Extension] Agent starting");
	});

	candy.on("tool_call", async (event) => {
		console.log(\`[Extension] Tool: \${event.toolName}\`);
		// Return { block: true, reason: "..." } to block execution
		return undefined;
	});

	candy.on("agent_end", async (event) => {
		console.log(\`[Extension] Low-level run ended, \${event.messages.length} messages\`);
	});

	// Register a custom tool
	candy.registerTool({
		name: "my_tool",
		label: "My Tool",
		description: "Does something useful",
		parameters: Type.Object({
			input: Type.String(),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => ({
			content: [{ type: "text", text: \`Processed: \${params.input}\` }],
			details: {},
		}),
	});

	// Register a command
	candy.registerCommand("mycommand", {
		description: "Do something",
		handler: async (args, ctx) => {
			ctx.ui.notify(\`Command executed with: \${args}\`);
		},
	});
}
*/
