/** Add a host-defined prompt template to templates discovered from disk. */

import {
	createAgentSessionRuntime,
	createSyntheticSourceInfo,
	type PromptTemplate,
	SessionManager,
} from "@candy/coding-agent";

const deployTemplate: PromptTemplate = {
	name: "deploy",
	description: "Deploy the application",
	filePath: "/virtual/prompts/deploy.md",
	sourceInfo: createSyntheticSourceInfo("/virtual/prompts/deploy.md", { source: "sdk" }),
	content: `# Deploy Instructions

1. Build: npm run build
2. Test: npm test
3. Deploy: npm run deploy`,
};

const cwd = process.cwd();
const runtime = await createAgentSessionRuntime({
	cwd,
	sessionManager: SessionManager.inMemory(cwd),
	resourceLoaderOptions: {
		promptsOverride: (current) => ({
			prompts: [...current.prompts, deployTemplate],
			diagnostics: current.diagnostics,
		}),
	},
});

try {
	const { prompts } = runtime.resources.getInventory().prompts;
	console.log("Prompt templates:");
	for (const prompt of prompts) console.log(`  /${prompt.name}: ${prompt.description}`);
} finally {
	await runtime.dispose();
}
