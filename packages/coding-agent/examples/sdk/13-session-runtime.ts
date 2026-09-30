import { createAgentSessionRuntime, SessionManager } from "@candy/coding-agent";

const runtime = await createAgentSessionRuntime({
	sessionManager: SessionManager.inMemory(process.cwd()),
});

try {
	console.log("Initial session:", runtime.session.sessionId);
	await runtime.newSession();
	console.log("New session:", runtime.session.sessionId);
	await runtime.session.prompt("List the files in this directory.");
} finally {
	await runtime.dispose();
}
