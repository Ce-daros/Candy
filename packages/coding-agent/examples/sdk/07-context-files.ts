/** Add host-provided AGENTS.md content to the discovered context files. */

import { createAgentSessionRuntime, SessionManager } from "@candy/coding-agent";

const cwd = process.cwd();
const runtime = await createAgentSessionRuntime({
	cwd,
	sessionManager: SessionManager.inMemory(cwd),
	resourceLoaderOptions: {
		agentsFilesOverride: (current) => ({
			agentsFiles: [
				...current.agentsFiles,
				{
					path: "/virtual/AGENTS.md",
					content: `# Project Guidelines

## Code Style
- Use TypeScript strict mode
- No any types
- Prefer const over let`,
				},
			],
		}),
	},
});

try {
	const instructions = runtime.resources.getInventory().instructions;
	console.log("Context files:");
	for (const file of instructions) console.log(`  - ${file.path}`);
} finally {
	await runtime.dispose();
}
