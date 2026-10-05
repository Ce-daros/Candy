import { homedir } from "node:os";
import { fauxAssistantMessage, InMemoryCredentialStore } from "@candy/ai";
import { fauxProvider } from "@candy/ai/providers/faux";
import { ModelRuntime, ReadOnlyAuthStorage } from "@candy/coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "vitest-evals/harness";
import {
	applyIsolatedEnvironment,
	CANDY_SESSION_SNAPSHOT_ARTIFACT,
	createCandyCodingAgentHarness,
	resolveModelSelection,
} from "../src/harness.ts";

afterEach(() => vi.restoreAllMocks());

describe("eval harness setup", () => {
	it.each(["success", "setup failure"] as const)("releases its model runtime after %s", async (outcome) => {
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("Paris")]);
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
		modelRuntime.registerNativeProvider({
			...faux.provider,
			auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: { apiKey: "faux-key" } }) } },
		});
		vi.spyOn(ModelRuntime, "create").mockResolvedValue(modelRuntime);
		vi.spyOn(ReadOnlyAuthStorage.prototype, "read").mockResolvedValue(undefined);
		const dispose = vi.spyOn(modelRuntime, "dispose");
		const model = faux.getModel();
		const harness = createCandyCodingAgentHarness({
			model: { provider: model.provider, id: model.id },
			noTools: "all",
			...(outcome === "setup failure" ? { workspaceFiles: { "../escaped": "bad" } } : {}),
		});
		const artifacts: Record<string, JsonValue> = {};
		const previousHome = process.env.HOME;
		const previousAgentDir = process.env.CANDY_CODING_AGENT_DIR;
		try {
			const run = harness.run("What is the capital of France?", {
				artifacts,
				setArtifact: (name, value) => {
					artifacts[name] = value;
				},
			});
			if (outcome === "success") {
				const result = await run;
				expect(result.output).toBe("Paris");
				expect(artifacts[CANDY_SESSION_SNAPSHOT_ARTIFACT]).toContain('"role":"assistant"');
			} else {
				await expect(run).rejects.toThrow("Workspace fixture escapes the workspace");
			}
			expect(dispose).toHaveBeenCalledOnce();
			expect(process.env.HOME).toBe(previousHome);
			expect(process.env.CANDY_CODING_AGENT_DIR).toBe(previousAgentDir);
		} finally {
			await modelRuntime.dispose();
		}
	});

	it("selects an explicit model or trimmed environment defaults", () => {
		expect(
			resolveModelSelection(
				{ provider: "anthropic", id: "claude-opus-4-6" },
				{ CANDY_PROVIDER: "openai-codex", CANDY_MODEL: "gpt-5.6-sol" },
			),
		).toEqual({ provider: "anthropic", id: "claude-opus-4-6" });
		expect(
			resolveModelSelection(undefined, { CANDY_PROVIDER: " openai-codex ", CANDY_MODEL: " gpt-5.6-sol " }),
		).toEqual({ provider: "openai-codex", id: "gpt-5.6-sol" });
		expect(() => resolveModelSelection(undefined, {})).toThrow("Select a harness model explicitly");
	});

	it("restores process environment after an isolated harness run", () => {
		const previousHome = process.env.HOME;
		const previousAgentDir = process.env.CANDY_CODING_AGENT_DIR;
		const restore = applyIsolatedEnvironment("/tmp/eval-home", "/tmp/eval-agent");
		try {
			expect(homedir()).toBe("/tmp/eval-home");
			expect(process.env.CANDY_CODING_AGENT_DIR).toBe("/tmp/eval-agent");
		} finally {
			restore();
		}
		expect(process.env.HOME).toBe(previousHome);
		expect(process.env.CANDY_CODING_AGENT_DIR).toBe(previousAgentDir);
	});
});
