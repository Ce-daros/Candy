/**
 * Full Control
 *
 * Replace everything - no discovery, explicit configuration.
 */

import {
	createAgentSessionRuntime,
	createExtensionRuntime,
	ModelRuntime,
	type ResourceLoader,
	SessionHistory,
	SettingsManager,
} from "@candy/coding-agent";

const modelRuntime = await ModelRuntime.create({
	authPath: "/tmp/my-agent/auth.json",
	modelsPath: "/tmp/my-agent/models.json",
});
if (process.env.MY_ANTHROPIC_KEY) {
	await modelRuntime.setRuntimeApiKey("anthropic", process.env.MY_ANTHROPIC_KEY);
}

const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Model not found");

// In-memory settings with overrides
const settingsManager = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 2 },
});

const cwd = process.cwd();

function createResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => `You are a minimal assistant.
Available: read, bash. Be concise.`,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

const sessionRuntime = await createAgentSessionRuntime({
	cwd,
	agentDir: "/tmp/my-agent",
	model,
	thinkingLevel: "off",
	modelRuntime,
	resourceLoaderFactory: () => createResourceLoader(),
	tools: ["read", "bash"],
	sessionManager: SessionHistory.inMemory(cwd),
	settingsManager,
});
const session = sessionRuntime.session;

try {
	session.execution.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await session.execution.prompt("List files in the current directory.");
	console.log();
} finally {
	await sessionRuntime.dispose();
}
