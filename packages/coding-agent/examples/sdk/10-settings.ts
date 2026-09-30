/**
 * Settings Configuration
 *
 * Override settings using SettingsManager.
 */

import { createAgentSessionRuntime, SessionManager, SettingsManager } from "@candy/coding-agent";

const cwd = process.cwd();

// Load current settings (merged global + project)
const settingsManagerFromDisk = SettingsManager.create(cwd);
console.log("Current settings:", JSON.stringify(settingsManagerFromDisk.getGlobalSettings(), null, 2));

// Override specific settings
const settingsManager = SettingsManager.create(cwd);
settingsManager.applyOverrides({
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
});

const customSettingsSessionRuntime = await createAgentSessionRuntime({
	cwd,
	settingsManager,
	sessionManager: SessionManager.inMemory(cwd),
});
console.log("Session created with custom settings");
await customSettingsSessionRuntime.dispose();

// The Promise resolves after the setting is validated, written, and published.
await settingsManager.setDefaultThinkingLevel("low");

// For testing without file I/O:
const inMemorySettings = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: false },
});

const testSessionRuntime = await createAgentSessionRuntime({
	cwd,
	settingsManager: inMemorySettings,
	sessionManager: SessionManager.inMemory(cwd),
});
console.log("Test session created with in-memory settings");
await testSessionRuntime.dispose();
