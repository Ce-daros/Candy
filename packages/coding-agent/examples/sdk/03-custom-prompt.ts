/** Replace or extend the generated system prompt without a UI adapter. */

import { createAgentSessionRuntime, SessionManager } from "@candy/coding-agent";

const cwd = process.cwd();

const replacementRuntime = await createAgentSessionRuntime({
	cwd,
	sessionManager: SessionManager.inMemory(cwd),
	resourceLoaderOptions: {
		systemPromptOverride: () => `You are a helpful assistant that speaks like a pirate.
Always end responses with "Arrr!"`,
		appendSystemPromptOverride: () => [],
	},
});

try {
	await replacementRuntime.session.prompt("What is 2 + 2?");
	console.log(replacementRuntime.session.getLastAssistantText());
} finally {
	await replacementRuntime.dispose();
}

const appendedRuntime = await createAgentSessionRuntime({
	cwd,
	sessionManager: SessionManager.inMemory(cwd),
	resourceLoaderOptions: {
		appendSystemPromptOverride: (base) => [
			...base,
			"## Additional Instructions\n- Always be concise\n- Use bullet points when listing things",
		],
	},
});

try {
	await appendedRuntime.session.prompt("List 3 benefits of TypeScript.");
	console.log(appendedRuntime.session.getLastAssistantText());
} finally {
	await appendedRuntime.dispose();
}
