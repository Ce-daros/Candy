/**
 * Tools Configuration
 *
 * Use tool names to choose which built-in tools are enabled.
 *
 * Tool names are matched against all available tools. If you use a custom `cwd`,
 * createAgentSessionRuntime() applies that cwd when it builds the actual built-in tools.
 *
 * For custom tools, see 06-extensions.ts - custom tools are registered via the
 * extensions system using candy.registerTool().
 */

import { createAgentSessionRuntime, SessionHistory } from "@candy/coding-agent";

// Read-only mode (no edit/write)
const readOnlySessionRuntime = await createAgentSessionRuntime({
	tools: ["read", "grep", "find", "ls"],
	sessionManager: SessionHistory.inMemory(),
});
console.log("Read-only session created");
await readOnlySessionRuntime.dispose();

// Custom tool selection
const customToolsSessionRuntime = await createAgentSessionRuntime({
	tools: ["read", "bash", "grep"],
	sessionManager: SessionHistory.inMemory(),
});
console.log("Custom tools session created");
await customToolsSessionRuntime.dispose();

// With custom cwd
const customCwd = "/path/to/project";
const customCwdSessionRuntime = await createAgentSessionRuntime({
	cwd: customCwd,
	tools: ["read", "bash", "edit", "write"],
	sessionManager: SessionHistory.inMemory(customCwd),
});
console.log("Custom cwd session created");
await customCwdSessionRuntime.dispose();

// Or pick specific tools for custom cwd
const specificToolsSessionRuntime = await createAgentSessionRuntime({
	cwd: customCwd,
	tools: ["read", "bash", "grep"],
	sessionManager: SessionHistory.inMemory(customCwd),
});
console.log("Specific tools with custom cwd session created");
await specificToolsSessionRuntime.dispose();
