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
	it("saves global skill toggles and supports project inherit, unload and load states", async () => {
		const manager = SettingsManager.inMemory();
		const configuration = new ResourceConfiguration(manager, cwd, agentDir, resolved);
		const pattern = "skills/deploy/SKILL.md";
		expect(configuration.toggleResource(skill)).toBe(false);
		await manager.flush();
		expect(manager.getGlobalSettings().skills).toEqual([`-${pattern}`]);
		configuration.setWriteScope("project");
		expect(configuration.getProjectOverrideState(skill)).toBe("inherit");
		expect(configuration.toggleResource(skill)).toBe(false);
		await manager.flush();
		expect(configuration.getProjectOverrideState(skill)).toBe("unload");
		expect(configuration.toggleResource(skill)).toBe(true);
		await manager.flush();
		expect(configuration.getProjectOverrideState(skill)).toBe("load");
		expect(configuration.toggleResource(skill)).toBe(true);
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
		expect(configuration.toggleResource(packagedSkill)).toBe(false);
		await manager.flush();
		expect(manager.getGlobalSettings().packages).toEqual([
			{ source: "npm:tools", skills: ["-skills/review/SKILL.md"] },
		]);
		configuration.setWriteScope("project");
		expect(configuration.toggleResource(packagedSkill)).toBe(false);
		await manager.flush();
		expect(manager.getProjectSettings().packages).toEqual([
			{ source: "npm:tools", autoload: false, skills: ["-skills/review/SKILL.md"] },
		]);
	});
});
