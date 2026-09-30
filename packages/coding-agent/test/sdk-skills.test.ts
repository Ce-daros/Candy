import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { SessionHistory } from "../src/core/session-history.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { extensionHostModules } from "../src/presentation/extensions/virtual-modules.ts";
import { resourceThemeAdapter } from "../src/presentation/resource-theme-adapter.ts";
import { assembleTestSession as assembleAgentSession } from "./session-factory.ts";

describe("assembleAgentSession skills option", () => {
	let tempDir: string;
	let skillsDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		skillsDir = join(tempDir, "skills", "test-skill");
		mkdirSync(skillsDir, { recursive: true });

		// Create a test skill in the candy skills directory
		writeFileSync(
			join(skillsDir, "SKILL.md"),
			`---
name: test-skill
description: A test skill for SDK tests.
---

# Test Skill

This is a test skill.
`,
		);
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("should discover skills by default and expose them on session.skills", async () => {
		const { session } = await assembleAgentSession({
			extensionModules: extensionHostModules,
			themeAdapter: resourceThemeAdapter,
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionHistory.inMemory(),
		});

		// Skills should be discovered and exposed on the session
		expect(session.execution.resourceLoader.getSkills().skills.length).toBeGreaterThan(0);
		expect(session.execution.resourceLoader.getSkills().skills.some((s) => s.name === "test-skill")).toBe(true);
	});

	it("should have empty skills when resource loader returns none (--no-skills)", async () => {
		const resourceLoader: ResourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		const { session } = await assembleAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionHistory.inMemory(),
			resourceLoader,
		});

		expect(session.execution.resourceLoader.getSkills().skills).toEqual([]);
		expect(session.execution.resourceLoader.getSkills().diagnostics).toEqual([]);
	});

	it("should use provided skills when resource loader supplies them", async () => {
		const customSkill = {
			name: "custom-skill",
			description: "A custom skill",
			filePath: "/fake/path/SKILL.md",
			baseDir: "/fake/path",
			sourceInfo: createSyntheticSourceInfo("/fake/path/SKILL.md", { source: "sdk" }),
			disableModelInvocation: false,
		};

		const resourceLoader: ResourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
			getSkills: () => ({ skills: [customSkill], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		const { session } = await assembleAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionHistory.inMemory(),
			resourceLoader,
		});

		expect(session.execution.resourceLoader.getSkills().skills).toEqual([customSkill]);
		expect(session.execution.resourceLoader.getSkills().diagnostics).toEqual([]);
	});
});
