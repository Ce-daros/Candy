import { beforeAll, describe, expect, it } from "vitest";
import { LoadedResourcesComponent } from "../src/modes/interactive/components/loaded-resources.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("LoadedResourcesComponent", () => {
	beforeAll(() => initTheme("dark"));

	const sections = [
		{ name: "Skills", entries: [{ name: "review", path: "/work/skills/review/SKILL.md", source: "Project" }] },
		{ name: "Themes", entries: [{ name: "soft", path: "/work/themes/soft.json" }] },
	];

	it("summarizes counts without rendering details", () => {
		const component = new LoadedResourcesComponent(sections);
		const collapsed = stripAnsi(component.render(100).join("\n"));
		expect(collapsed).toContain("Loaded resources · 2  1 skills · 1 themes");
		expect(collapsed).not.toContain("/work/skills");
	});

	it("reveals names, sources, and paths when constructed expanded", () => {
		const component = new LoadedResourcesComponent(sections, true);
		const expanded = stripAnsi(component.render(100).join("\n"));
		expect(expanded).toContain("review  · Project");
		expect(expanded).toContain("/work/skills/review/SKILL.md");
	});
});
