import { join } from "node:path";
import { Agent } from "@candy/agent-core";
import { fauxAssistantMessage } from "@candy/ai";
import { streamSimple } from "@candy/ai/compat";
import type { Terminal } from "@candy/tui";
import tpsExtension from "../../../../.candy/extensions/tps.ts";
import { AgentSession } from "../../src/core/agent-session.ts";
import {
	type AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../src/core/agent-session-runtime.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { userMsg } from "../utilities.ts";

export interface InteractiveSmoke {
	mode: InteractiveMode;
	runtime: AgentSessionRuntime;
	harness: Harness;
	cleanup(): Promise<void>;
}

export async function createInteractiveSmoke(
	options: {
		terminal?: Terminal;
		animations?: boolean;
		empty?: boolean;
		theme?: "dark" | "light";
		longModelName?: boolean;
		transcript?: boolean;
	} = {},
): Promise<InteractiveSmoke> {
	const harness = await createHarness({
		tokensPerSecond: options.transcript ? 20 : undefined,
		extensionFactories: options.transcript ? [tpsExtension] : undefined,
		models: [
			{
				id: "candy-reasoning",
				name: options.longModelName
					? "Candy Reasoning · multilingual 中文模型 with a deliberately long display name"
					: "Candy Reasoning",
				reasoning: true,
			},
			{ id: "candy-off", name: "Candy Off", reasoning: false },
		],
		settings: { uiAnimations: options.animations ?? true, quietStartup: true, theme: options.theme ?? "dark" },
	});
	harness.settingsManager.setScopedModels(
		harness.models.map((model) => ({ provider: model.provider, modelId: model.id })),
	);
	harness.setResponses(
		Array.from({ length: 20 }, () =>
			fauxAssistantMessage(
				options.transcript
					? [
							{
								type: "thinking",
								thinking: "Checking the first idea.\n思考内容保持灰色，等待正文。\n第三行。\n第四行。",
							},
							{ type: "text", text: "First reply. 中文正文与符号对齐。" },
							{
								type: "thinking",
								thinking: "Checking a second idea after the reply.\n第二行。\n第三行。\n第四行。",
							},
							{ type: "text", text: "Final reply. Click the star to inspect usage." },
						]
					: "Faux response",
			),
		),
	);
	const sessionDir = join(harness.tempDir, "sessions");
	const sessionManager = SessionManager.create(harness.tempDir, sessionDir);
	if (!options.empty) {
		sessionManager.appendMessage(userMsg("First question"));
		const firstAssistant = sessionManager.appendMessage(fauxAssistantMessage("First answer"));
		sessionManager.appendMessage(userMsg("Second question"));
		sessionManager.appendMessage(fauxAssistantMessage("Second answer"));
		sessionManager.branch(firstAssistant);
		sessionManager.appendMessage(userMsg("Branch question"));
		sessionManager.appendMessage(fauxAssistantMessage("Branch answer"));
	}
	const otherSession = SessionManager.create(harness.tempDir, sessionDir);
	otherSession.appendMessage(userMsg("Another session"));
	otherSession.appendMessage(fauxAssistantMessage("Another answer"));
	initTheme(options.theme ?? "dark", false);
	const services: AgentSessionServices = {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: harness.session.resourceLoader,
		diagnostics: [],
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const agent = new Agent({
			getApiKey: () => "faux-key",
			streamFn: streamSimple,
			initialState: {
				model: harness.getModel(),
				systemPrompt: "",
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: harness.settingsManager,
			cwd,
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			sessionStartEvent,
		});
		return {
			session,
			extensionsResult: harness.session.resourceLoader.getExtensions(),
			services: { ...services, cwd },
			diagnostics: [],
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		sessionManager,
	});
	const mode = new InteractiveMode(runtime, { terminal: options.terminal });
	return {
		mode,
		runtime,
		harness,
		async cleanup() {
			mode.stop();
			await runtime.dispose();
			harness.cleanup();
		},
	};
}
