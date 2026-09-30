import { createAgentSessionRuntime, SessionHistory } from "@candy/coding-agent";

const runtime = await createAgentSessionRuntime({
	sessionManager: SessionHistory.inMemory(process.cwd()),
});

try {
	console.log("Initial session:", runtime.session.history.getSessionId());
	await runtime.newSession();
	console.log("New session:", runtime.session.history.getSessionId());
	await runtime.session.execution.prompt("List the files in this directory.");
} finally {
	await runtime.dispose();
}
