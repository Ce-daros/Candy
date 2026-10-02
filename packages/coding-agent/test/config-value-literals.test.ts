import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";

import { createTestModelRuntime } from "./model-runtime-test-utils.ts";

describe("config value literals", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	function createAgentDir(): string {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "candy-config-value-test-"));
		tempDirs.push(agentDir);
		return agentDir;
	}

	it.each([
		["malformed", '{\n  "providers": {\n'],
		["blank", ""],
	])("reports a parse error for %s models.json", async (_name, content) => {
		const agentDir = createAgentDir();
		const modelsPath = path.join(agentDir, "models.json");
		fs.writeFileSync(modelsPath, content, "utf-8");

		expect(fs.readFileSync(modelsPath, "utf-8")).toBe(content);
		const runtime = await createTestModelRuntime(AuthStorage.create(path.join(agentDir, "auth.json")), modelsPath);
		const loadError = runtime.getError();
		expect(loadError).toContain("Failed to parse models.json");
		expect(loadError).toContain(`File: ${modelsPath}`);
	});

	it("leaves uppercase models.json API key and header values unchanged", async () => {
		const agentDir = createAgentDir();
		const envKeys = ["CUSTOM_API_KEY", "HEADER_API_KEY", "MODEL_API_KEY", "OVERRIDE_API_KEY"];
		const savedEnv: Record<string, string | undefined> = {};
		for (const key of envKeys) {
			savedEnv[key] = process.env[key];
			process.env[key] = `env-${key}`;
		}

		try {
			fs.writeFileSync(
				path.join(agentDir, "models.json"),
				`${JSON.stringify(
					{
						providers: {
							"custom-provider": {
								baseUrl: "https://example.com/v1",
								apiKey: "CUSTOM_API_KEY",
								api: "openai-completions",
								headers: {
									"x-api-key": "HEADER_API_KEY",
									"x-literal": "literal",
								},
								models: [
									{
										id: "model-a",
										headers: { "x-model-key": "MODEL_API_KEY" },
									},
								],
								modelOverrides: {
									"model-b": { headers: { "x-override-key": "OVERRIDE_API_KEY" } },
								},
							},
						},
					},
					null,
					2,
				)}\n`,
				"utf-8",
			);
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			const stored = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf-8")) as {
				providers: Record<
					string,
					{
						apiKey?: string;
						headers?: Record<string, string>;
						models?: Array<{ headers?: Record<string, string> }>;
						modelOverrides?: Record<string, { headers?: Record<string, string> }>;
					}
				>;
			};
			const provider = stored.providers["custom-provider"]!;
			expect(provider.apiKey).toBe("CUSTOM_API_KEY");
			expect(provider.headers?.["x-api-key"]).toBe("HEADER_API_KEY");
			expect(provider.headers?.["x-literal"]).toBe("literal");
			expect(provider.models?.[0]?.headers?.["x-model-key"]).toBe("MODEL_API_KEY");
			expect(provider.modelOverrides?.["model-b"]?.headers?.["x-override-key"]).toBe("OVERRIDE_API_KEY");
			expect(logSpy).not.toHaveBeenCalled();

			const runtime = await createTestModelRuntime(
				AuthStorage.create(path.join(agentDir, "auth.json")),
				path.join(agentDir, "models.json"),
			);
			const model = runtime.getModel("custom-provider", "model-a");
			expect(model).toBeDefined();
			expect((await runtime.getAuth("custom-provider"))?.auth.apiKey).toBe("CUSTOM_API_KEY");
			expect(await runtime.getAuth(model!)).toMatchObject({
				auth: {
					apiKey: "CUSTOM_API_KEY",
					headers: {
						"x-api-key": "HEADER_API_KEY",
						"x-literal": "literal",
						"x-model-key": "MODEL_API_KEY",
					},
				},
			});
		} finally {
			for (const key of envKeys) {
				if (savedEnv[key] === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = savedEnv[key];
				}
			}
		}
	});
});
