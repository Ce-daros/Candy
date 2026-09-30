import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@candy/agent-core";
import { afterEach } from "vitest";
import { assembleAgentSession, type CreateAgentSessionOptions } from "../src/core/agent-session-factory.ts";
import { assembleAgentSessionServices } from "../src/core/agent-session-services.ts";
import { SessionHistory } from "../src/core/session-history.ts";
import { extensionHostModules } from "../src/presentation/extensions/virtual-modules.ts";
import { resourceThemeAdapter } from "../src/presentation/resource-theme-adapter.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

export async function assembleTestSession(options: CreateAgentSessionOptions) {
	const directory = mkdtempSync(join(tmpdir(), "candy-session-test-"));
	const cwd = options.cwd ?? directory;
	const agentDir = options.agentDir ?? directory;
	const services = await assembleAgentSessionServices({
		cwd,
		agentDir,
		modelRuntime: options.modelRuntime,
		settingsManager: options.settingsManager,
		resourceLoader: options.resourceLoader,
		extensionModules: options.extensionModules ?? extensionHostModules,
		themeAdapter: options.themeAdapter ?? resourceThemeAdapter,
	});
	const result = await assembleAgentSession({
		...options,
		cwd,
		agentDir,
		modelRuntime: services.modelRuntime,
		settingsManager: services.settingsManager,
		resourceLoader: services.resourceLoader,
		sessionManager: options.sessionManager ?? SessionHistory.inMemory(cwd),
	});
	cleanups.push(async () => {
		await result.session.execution.dispose();
		await services.dispose();
		rmSync(directory, { recursive: true });
	});
	return result;
}

export function seedHistory(history: SessionHistory, messages: AgentMessage[]): void {
	history.resetLeaf();
	for (const message of messages) {
		if (message.role === "branchSummary" || message.role === "compactionSummary")
			throw new Error("Seed committed messages, not projected summaries");
		if (message.role === "custom")
			history.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		else history.appendMessage(message);
	}
}
