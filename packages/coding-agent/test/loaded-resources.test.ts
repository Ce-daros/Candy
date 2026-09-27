import { beforeAll, describe, expect, it } from "vitest";
import { LoadedResourcesComponent } from "../src/modes/interactive/components/loaded-resources.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("LoadedResourcesComponent", () => {
	beforeAll(() => initTheme("dark"));

	it("summarizes counts and reveals names, sources, and paths", () => {
		const component = new LoadedResourcesComponent([
			{ name: "Skills", entries: [{ name: "review", path: "/work/skills/review/SKILL.md", source: "Project" }] },
			{ name: "Themes", entries: [{ name: "soft", path: "/work/themes/soft.json" }] },
		]);
		const collapsed = stripAnsi(component.render(100).join("\n"));
		expect(collapsed).toContain("2  1 skills · 1 themes");
		expect(collapsed).not.toContain("/work/skills");
		component.handleMouse({ type: "click", button: "left", y: 0 } as Parameters<typeof component.handleMouse>[0]);
		const expanded = stripAnsi(component.render(100).join("\n"));
		expect(expanded).toContain("review  · Project");
		expect(expanded).toContain("/work/skills/review/SKILL.md");
		component.setExpanded(false);
		expect(component.getExpanded()).toBe(false);
	});
});
