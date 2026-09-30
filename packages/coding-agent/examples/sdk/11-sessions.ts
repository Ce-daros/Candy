/**
 * Session Management
 *
 * Control session persistence: in-memory, new file, continue, or open specific.
 */

import { createAgentSessionRuntime, SessionDiscovery, SessionHistory } from "@candy/coding-agent";

const cwd = process.cwd();

// In-memory (no persistence)
const inMemoryRuntime = await createAgentSessionRuntime({
	cwd,
	sessionManager: SessionHistory.inMemory(cwd),
});
const inMemory = inMemoryRuntime.session;
console.log("In-memory session:", inMemory.history.getSessionFile() ?? "(none)");
await inMemoryRuntime.dispose();

// New persistent session
const newSessionRuntime = await createAgentSessionRuntime({
	cwd,
	sessionManager: SessionHistory.create(cwd),
});
const newSession = newSessionRuntime.session;
console.log("New session file:", newSession.history.getSessionFile());
await newSessionRuntime.dispose();

// Continue most recent session (or create new if none)
const continuedRuntime = await createAgentSessionRuntime({
	cwd,
	sessionManager: SessionHistory.continueRecent(cwd),
});
const { session: continued, modelFallbackMessage } = continuedRuntime;
if (modelFallbackMessage) console.log("Note:", modelFallbackMessage);
console.log("Continued session:", continued.history.getSessionFile());
await continuedRuntime.dispose();

// List and open specific session
const sessions = await SessionDiscovery.list(cwd);
console.log(`\nFound ${sessions.length} sessions:`);
for (const info of sessions.slice(0, 3)) {
	console.log(`  ${info.id.slice(0, 8)}... - "${info.firstMessage.slice(0, 30)}..."`);
}

if (sessions.length > 0) {
	const openedRuntime = await createAgentSessionRuntime({
		sessionManager: SessionHistory.open(sessions[0].path),
	});
	console.log(`\nOpened: ${openedRuntime.session.history.getSessionId()}`);
	await openedRuntime.dispose();
}

// Custom session directory (no cwd encoding)
// const customDir = "/path/to/my-sessions";
// const sessionRuntime = await createAgentSessionRuntime({
//   sessionManager: SessionHistory.create(process.cwd(), customDir),
// });
// SessionDiscovery.list(process.cwd(), customDir);
// SessionHistory.continueRecent(process.cwd(), customDir);
