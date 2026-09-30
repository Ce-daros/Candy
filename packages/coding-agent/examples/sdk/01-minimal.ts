/**
 * Minimal SDK Usage
 *
 * Uses all defaults: discovers skills, extensions, tools, context files
 * from cwd and ~/.candy/agent. Model chosen from settings or first available.
 */

import { createAgentSessionRuntime } from "@candy/coding-agent";

const runtime = await createAgentSessionRuntime();
const session = runtime.session;
const unsubscribe = session.execution.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

try {
	await session.execution.prompt("What files are in the current directory?");
	session.history.buildSessionProjection().messages.forEach((msg) => {
		console.log(msg);
	});
	console.log();
} finally {
	unsubscribe();
	await runtime.dispose();
}
