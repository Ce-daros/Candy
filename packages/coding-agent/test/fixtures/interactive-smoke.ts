import { join } from "node:path";
import { fauxAssistantMessage } from "@candy/ai";
import type { Terminal } from "@candy/tui";
import tpsExtension from "../../../../.candy/extensions/tps.ts";
import { assembleAgentSession } from "../../src/core/agent-session-factory.ts";
import {
	type AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createRuntimeFromFactory,
} from "../../src/core/agent-session-runtime.ts";
import { SessionHistory } from "../../src/core/session-history.ts";
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
	await harness.settingsManager.setScopedModels(
		harness.models.map((model) => ({ provider: model.provider, modelId: model.id })),
	);
	harness.setResponses(
		Array.from({ length: 20 }, () =>
			fauxAssistantMessage(
				options.transcript
					? [
							{
								type: "thinking",
								thinking:
									"Checking the first idea.\n思考内容保持灰色，等待正文。\n第三行。\n第四行。" +
									"\n" +
									"Thinking continues beyond the fold budget. ".repeat(8),
							},
							{ type: "text", text: "First reply. 中文正文与符号对齐。" },
							{
								type: "thinking",
								thinking:
									"Checking a second idea after the reply.\n第二行。\n第三行。\n第四行。" +
									"\n" +
									"The second thought also continues beyond the fold budget. ".repeat(5),
							},
							{ type: "text", text: "Final reply. Click the star to inspect usage." },
						]
					: "Faux response",
			),
		),
	);
	const sessionDir = join(harness.tempDir, "sessions");
	const sessionManager = SessionHistory.create(harness.tempDir, sessionDir);
	if (!options.empty) {
		sessionManager.appendMessage(userMsg("First question"));
		const firstAssistant = sessionManager.appendMessage(fauxAssistantMessage("First answer"));
		sessionManager.appendMessage(userMsg("Second question"));
		sessionManager.appendMessage(fauxAssistantMessage("Second answer"));
		sessionManager.branch(firstAssistant);
		sessionManager.appendMessage(userMsg("Branch question"));
		sessionManager.appendMessage(fauxAssistantMessage("Branch answer"));
	}
	const otherSession = SessionHistory.create(harness.tempDir, sessionDir);
	otherSession.appendMessage(userMsg("Another session"));
	otherSession.appendMessage(fauxAssistantMessage("Another answer"));
	initTheme(options.theme ?? "dark", false);
	const services: AgentSessionServices = {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.execution.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: harness.session.execution.resourceLoader,
		diagnostics: [],
		dispose: async () => {},
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const { session } = await assembleAgentSession({
			sessionManager,
			settingsManager: harness.settingsManager,
			cwd,
			agentDir: harness.tempDir,
			model: harness.getModel(),
			noTools: "all",
			modelRuntime: harness.session.execution.modelRuntime,
			resourceLoader: harness.session.execution.resourceLoader,
			sessionStartEvent,
		});
		return {
			session,
			extensionsResult: harness.session.execution.resourceLoader.getExtensions(),
			services: { ...services, cwd },
			diagnostics: [],
		};
	};
	const runtime = await createRuntimeFromFactory(createRuntime, {
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
			await harness.cleanup();
		},
	};
}
