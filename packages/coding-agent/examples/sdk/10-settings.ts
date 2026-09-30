/**
 * Settings Configuration
 *
 * Override settings using SettingsManager.
 */

import { createAgentSessionRuntime, SessionHistory, SettingsManager } from "@candy/coding-agent";

const cwd = process.cwd();

// Read the effective value through the shared setting definition.
const settingsManagerFromDisk = SettingsManager.create(cwd);
console.log("Default thinking level:", settingsManagerFromDisk.read("default-thinking-level"));

// Override specific settings
const settingsManager = SettingsManager.create(cwd);
settingsManager.applyOverrides({
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
});

const customSettingsSessionRuntime = await createAgentSessionRuntime({
	cwd,
	settingsManager,
	sessionManager: SessionHistory.inMemory(cwd),
});
console.log("Session created with custom settings");
await customSettingsSessionRuntime.dispose();

// The Promise resolves after the setting is validated, written, and published.
await settingsManager.commitSetting("global", "defaultThinkingLevel", "low");

// For testing without file I/O:
const inMemorySettings = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: false },
});

const testSessionRuntime = await createAgentSessionRuntime({
	cwd,
	settingsManager: inMemorySettings,
	sessionManager: SessionHistory.inMemory(cwd),
});
console.log("Test session created with in-memory settings");
await testSessionRuntime.dispose();
