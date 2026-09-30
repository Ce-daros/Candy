/** Filter discovered skills and add one supplied by the host. */

import { createAgentSessionRuntime, createSyntheticSourceInfo, SessionHistory, type Skill } from "@candy/coding-agent";

const customSkill: Skill = {
	name: "my-skill",
	description: "Custom project instructions",
	filePath: "/virtual/SKILL.md",
	baseDir: "/virtual",
	sourceInfo: createSyntheticSourceInfo("/virtual/SKILL.md", { source: "sdk" }),
	disableModelInvocation: false,
};

const cwd = process.cwd();
const runtime = await createAgentSessionRuntime({
	cwd,
	sessionManager: SessionHistory.inMemory(cwd),
	resourceLoaderOptions: {
		skillsOverride: (current) => ({
			skills: [
				...current.skills.filter((skill) => skill.name.includes("browser") || skill.name.includes("search")),
				customSkill,
			],
			diagnostics: current.diagnostics,
		}),
	},
});

try {
	const { skills, diagnostics } = runtime.resources.getInventory().skills;
	console.log(
		"Skills:",
		skills.map((skill) => skill.name),
	);
	if (diagnostics.length) console.log("Warnings:", diagnostics);
} finally {
	await runtime.dispose();
}
