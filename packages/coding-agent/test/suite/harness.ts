import { assembleAgentSession } from "../../src/core/agent-session-factory.ts";
import { createInMemoryModelRuntime, createTestModelRuntime } from "../model-runtime-test-utils.ts";
/**
 * Local test harness for the new coding-agent test suite.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@candy/agent-core";
import type { Model } from "@candy/ai";
import {
	type FauxModelDefinition,
	type FauxProviderHandle,
	type FauxResponseStep,
	fauxProvider,
} from "@candy/ai/providers/faux";
import type { AgentSession, AgentSessionEvent } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionHistory } from "../../src/core/session-history.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { InlineExtension, ResourceLoader } from "../../src/index.ts";
import { configuredFauxProvider } from "../ai.ts";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "../utilities.ts";

type MessageTextPart = { type: "text"; text: string };

export function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return "";
	}
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is MessageTextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function getUserTexts(harness: Harness): string[] {
	return harness.session.execution.messages
		.filter((message) => message.role === "user")
		.map((message) => getMessageText(message));
}

export function getAssistantTexts(harness: Harness): string[] {
	return harness.session.execution.messages
		.filter((message) => message.role === "assistant")
		.map((message) => getMessageText(message));
}

export interface HarnessOptions {
	tokensPerSecond?: number;
	models?: FauxModelDefinition[];
	settings?: Partial<Settings>;
	tools?: AgentTool[];
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	resourceLoader?: ResourceLoader;
	extensionFactories?: Array<InlineExtension | CreateTestExtensionsResultInput>;
	withConfiguredAuth?: boolean;
	modelsJson?: Record<string, unknown>;
}

export interface Harness {
	session: AgentSession;
	sessionManager: SessionHistory;
	settingsManager: SettingsManager;
	authStorage: AuthStorage;
	readonly modelRuntime: ModelRuntime;
	faux: FauxProviderHandle;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	events: AgentSessionEvent[];
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	tempDir: string;
	cleanup: () => Promise<void>;
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `pi-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = createTempDir();
	const faux: FauxProviderHandle = fauxProvider({
		models: options.models,
		tokensPerSecond: options.tokensPerSecond,
	});
	faux.setResponses([]);
	const model = faux.getModel();
	const toolMap = options.tools ? Object.fromEntries(options.tools.map((tool) => [tool.name, tool])) : undefined;
	const withConfiguredAuth = options.withConfiguredAuth ?? true;

	const sessionManager = SessionHistory.inMemory(tempDir);
	const settingsManager = SettingsManager.inMemory(options.settings);

	const authStorage = AuthStorage.inMemory();
	if (withConfiguredAuth) {
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	}
	const modelsPath = options.modelsJson === undefined ? undefined : join(tempDir, "models.json");
	if (modelsPath) writeFileSync(modelsPath, JSON.stringify(options.modelsJson));
	const modelRuntime = modelsPath
		? await createTestModelRuntime(authStorage, modelsPath)
		: await createInMemoryModelRuntime(authStorage);
	modelRuntime.registerNativeProvider(
		withConfiguredAuth
			? configuredFauxProvider(faux)
			: { ...faux.provider, auth: { apiKey: { name: "Faux", resolve: async () => undefined } } },
	);
	await modelRuntime.refresh({ allowNetwork: false });

	const extensionsResult = options.extensionFactories
		? await createTestExtensionsResult(options.extensionFactories, tempDir)
		: undefined;
	const resourceLoader =
		options.resourceLoader ?? createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined);

	const { session } = await assembleAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		model,
		modelRuntime,
		settingsManager,
		sessionManager,
		resourceLoader,
		baseToolsOverride: toolMap,
		initialActiveToolNames: options.initialActiveToolNames,
		tools: options.allowedToolNames,
		excludeTools: options.excludedToolNames,
	});

	const events: AgentSessionEvent[] = [];
	session.execution.subscribe((event) => {
		events.push(event);
	});

	return {
		session,
		sessionManager,
		settingsManager,
		authStorage,
		modelRuntime,
		faux,
		models: faux.models,
		getModel: faux.getModel,
		setResponses: faux.setResponses,
		appendResponses: faux.appendResponses,
		getPendingResponseCount: faux.getPendingResponseCount,
		events,
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
		},
		tempDir,
		async cleanup() {
			await session.execution.dispose();
			await modelRuntime.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}
