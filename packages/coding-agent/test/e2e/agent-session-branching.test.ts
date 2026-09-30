import { extensionHostModules } from "../../src/presentation/extensions/virtual-modules.ts";
import { resourceThemeAdapter } from "../../src/presentation/resource-theme-adapter.ts";
import { getTestAgent } from "../execution-internals.ts";
/**
 * Tests for AgentSession forking behavior.
 *
 * These tests verify:
 * - Forking from a single message works
 * - Forking in --no-session mode (in-memory only)
 * - getUserMessagesForForking returns correct entries
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinModel as getModel } from "@candy/ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import {
	type AgentSessionRuntime,
	assembleAgentSessionFromServices,
	assembleAgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createRuntimeFromFactory,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionHistory } from "../../src/core/session-history.ts";
import { API_KEY } from "../utilities.ts";

describe.skipIf(!API_KEY)("AgentSession forking", () => {
	let session: AgentSession;
	let runtimeHost: AgentSessionRuntime;
	let tempDir: string;
	let sessionManager: SessionHistory;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-branching-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (runtimeHost) {
			await runtimeHost.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(noSession: boolean = false) {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		sessionManager = noSession ? SessionHistory.inMemory(tempDir) : SessionHistory.create(tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: API_KEY! }));

		const servicesOptions = {
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await assembleAgentSessionServices({
				extensionModules: extensionHostModules,
				themeAdapter: resourceThemeAdapter,
				...servicesOptions,
				cwd,
			});
			return {
				...(await assembleAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model,
					tools: ["read", "bash", "edit", "write"],
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		runtimeHost = await createRuntimeFromFactory(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
		});
		session = runtimeHost.session;
		session.execution.subscribe(() => {});
		return session;
	}

	it("should allow forking from single message", async () => {
		await createSession();

		await session.execution.prompt("Say hello");
		await getTestAgent(session.execution).waitForIdle();

		const userMessages = session.history.getUserMessagesForForking();
		expect(userMessages.length).toBe(1);
		expect(userMessages[0].text).toBe("Say hello");

		const result = await runtimeHost.fork(userMessages[0].entryId);
		expect(result.cancelled).toBe(false);
		session = runtimeHost.session;
		expect(result.selectedText).toBe("Say hello");

		expect(session.execution.messages.length).toBe(0);
		expect(session.execution.sessionFile).not.toBeNull();
		expect(existsSync(session.execution.sessionFile!)).toBe(false);
	});

	it("should support in-memory forking in --no-session mode", async () => {
		await createSession(true);

		expect(session.execution.sessionFile).toBeUndefined();

		await session.execution.prompt("Say hi");
		await getTestAgent(session.execution).waitForIdle();

		const userMessages = session.history.getUserMessagesForForking();
		expect(userMessages.length).toBe(1);
		expect(session.execution.messages.length).toBeGreaterThan(0);

		const result = await runtimeHost.fork(userMessages[0].entryId);
		expect(result.cancelled).toBe(false);
		session = runtimeHost.session;
		expect(result.selectedText).toBe("Say hi");

		expect(session.execution.messages.length).toBe(0);
		expect(session.execution.sessionFile).toBeUndefined();
	});

	it("should fork from middle of conversation", async () => {
		await createSession();

		await session.execution.prompt("Say one");
		await getTestAgent(session.execution).waitForIdle();

		await session.execution.prompt("Say two");
		await getTestAgent(session.execution).waitForIdle();

		await session.execution.prompt("Say three");
		await getTestAgent(session.execution).waitForIdle();

		const userMessages = session.history.getUserMessagesForForking();
		expect(userMessages.length).toBe(3);

		const secondMessage = userMessages[1];
		const result = await runtimeHost.fork(secondMessage.entryId);
		expect(result.cancelled).toBe(false);
		session = runtimeHost.session;
		expect(result.selectedText).toBe("Say two");

		expect(session.execution.messages.length).toBe(2);
		expect(session.execution.messages[0].role).toBe("user");
		expect(session.execution.messages[1].role).toBe("assistant");
	}, 60000);
});
