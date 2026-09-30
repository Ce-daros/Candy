/**
 * API Keys and OAuth
 *
 * Configure provider auth through ModelRuntime.
 */

import { createAgentSessionRuntime, SessionHistory } from "@candy/coding-agent";

const cwd = process.cwd();
const runtime = await createAgentSessionRuntime({
	cwd,
	sessionManager: SessionHistory.inMemory(cwd),
	modelRuntimeOptions: {
		authPath: "/tmp/my-app/auth.json",
		modelsPath: "/tmp/my-app/models.json",
	},
});

try {
	if (process.env.ANTHROPIC_API_KEY) {
		await runtime.models.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY);
	}
	console.log("Session with configured credentials and model storage");
} finally {
	await runtime.dispose();
}
