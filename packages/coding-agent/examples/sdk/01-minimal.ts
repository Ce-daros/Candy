import { resourceThemeAdapter } from "@candy/coding-agent";
import { extensionHostModules } from "@candy/coding-agent/extension-host-modules";
/**
 * Minimal SDK Usage
 *
 * Uses all defaults: discovers skills, extensions, tools, context files
 * from cwd and ~/.candy/agent. Model chosen from settings or first available.
 */

import { createAgentSession } from "@candy/coding-agent";

const { session } = await createAgentSession({
	extensionModules: extensionHostModules,
	themeAdapter: resourceThemeAdapter,
});

try {
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await session.prompt("What files are in the current directory?");
	session.state.messages.forEach((msg) => {
		console.log(msg);
	});
	console.log();
} finally {
	session.dispose();
}
