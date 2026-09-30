import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedPaths } from "../src/core/package-manager.ts";
import { ResourceConfiguration } from "../src/core/resource-configuration.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const cwd = join(process.cwd(), "demo-project");
const agentDir = join(process.cwd(), "demo-agent");
const skill = {
	path: join(agentDir, "skills", "deploy", "SKILL.md"),
	enabled: true,
	metadata: { source: "auto", scope: "user" as const, origin: "top-level" as const, baseDir: agentDir },
	resourceType: "skills" as const,
};
const resolved: ResolvedPaths = { extensions: [], skills: [skill], prompts: [], themes: [] };

describe("resource configuration", () => {
	it("resolves the supplied global configuration for an in-memory runtime", async () => {
		const directory = mkdtempSync(join(tmpdir(), "candy-resource-config-"));
		try {
			const configuredPrompt = join(directory, "configured.md");
			const diskPrompt = join(directory, "disk.md");
			const agentDirectory = join(directory, "agent");
			mkdirSync(agentDirectory);
			writeFileSync(configuredPrompt, "Configured prompt");
			writeFileSync(diskPrompt, "Disk prompt");
			writeFileSync(join(agentDirectory, "settings.json"), JSON.stringify({ prompts: [diskPrompt] }));
			const settings = SettingsManager.inMemory({ prompts: [configuredPrompt] }, { projectTrusted: false });
			const paths = await ResourceConfiguration.resolve(settings, directory, agentDirectory);
			expect(paths.global.prompts.map((prompt) => prompt.path)).toContain(configuredPrompt);
			expect(paths.global.prompts.map((prompt) => prompt.path)).not.toContain(diskPrompt);
			expect(paths.project).toEqual(paths.global);
		} finally {
			rmSync(directory, { recursive: true });
		}
	});

	it("saves global skill toggles and supports project inherit, unload and load states", async () => {
		const manager = SettingsManager.inMemory();
		const configuration = new ResourceConfiguration(manager, cwd, agentDir, resolved);
		const pattern = "skills/deploy/SKILL.md";
		expect(await configuration.toggleResource(skill)).toBe(false);
		await manager.flush();
		expect(manager.getGlobalSettings().skills).toEqual([`-${pattern}`]);
		configuration.setWriteScope("project");
		expect(configuration.getProjectOverrideState(skill)).toBe("inherit");
		expect(await configuration.toggleResource(skill)).toBe(false);
		await manager.flush();
		expect(configuration.getProjectOverrideState(skill)).toBe("unload");
		expect(await configuration.toggleResource(skill)).toBe(true);
		await manager.flush();
		expect(configuration.getProjectOverrideState(skill)).toBe("load");
		expect(await configuration.toggleResource(skill)).toBe(true);
		await manager.flush();
		expect(configuration.getProjectOverrideState(skill)).toBe("inherit");
	});

	it("writes package skill filters in the selected scope", async () => {
		const packageRoot = join(agentDir, "packages", "tools");
		const packagedSkill = {
			path: join(packageRoot, "skills", "review", "SKILL.md"),
			enabled: true,
			metadata: {
				source: "npm:tools",
				scope: "user" as const,
				origin: "package" as const,
				baseDir: packageRoot,
			},
			resourceType: "skills" as const,
		};
		const manager = SettingsManager.inMemory({ packages: ["npm:tools"] });
		const configuration = new ResourceConfiguration(manager, cwd, agentDir, {
			...resolved,
			skills: [packagedSkill],
		});
		expect(await configuration.toggleResource(packagedSkill)).toBe(false);
		await manager.flush();
		expect(manager.getGlobalSettings().packages).toEqual([
			{ source: "npm:tools", skills: ["-skills/review/SKILL.md"] },
		]);
		configuration.setWriteScope("project");
		expect(await configuration.toggleResource(packagedSkill)).toBe(false);
		await manager.flush();
		expect(manager.getProjectSettings().packages).toEqual([
			{ source: "npm:tools", autoload: false, skills: ["-skills/review/SKILL.md"] },
		]);
	});
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
