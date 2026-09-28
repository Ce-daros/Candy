import type { TuiMouseEvent } from "@candy/tui";
import { describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	ConfigSelectorComponent,
	type ScopedResolvedPaths,
} from "../src/modes/interactive/components/config-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const skillPath = "C:/demo/.candy/skills/review/SKILL.md";

function createSelector(options: ConstructorParameters<typeof ConfigSelectorComponent>[11] = {}) {
	const empty = { extensions: [], skills: [], prompts: [], themes: [] };
	const resolved: ScopedResolvedPaths = {
		global: {
			...empty,
			skills: [
				{
					path: skillPath,
					enabled: false,
					metadata: { source: "auto", scope: "user", origin: "top-level", baseDir: "C:/demo/.candy" },
				},
			],
		},
		project: empty,
	};
	return new ConfigSelectorComponent(
		resolved,
		SettingsManager.inMemory(),
		"C:/demo",
		"C:/demo/.candy",
		() => {},
		() => {},
		() => {},
		24,
		"global",
		false,
		undefined,
		{ resourceTypes: ["skills"], ...options },
	);
}

describe("ConfigSelectorComponent", () => {
	it("opens a disabled resource on Enter", () => {
		initTheme("dark");
		const onOpen = vi.fn();
		const selector = createSelector({ onOpen });
		selector.getResourceList().handleInput("\r");
		expect(onOpen).toHaveBeenCalledWith(skillPath);
	});

	it("shows a beforeToggle reason and leaves settings unchanged", async () => {
		initTheme("dark");
		const settings = SettingsManager.inMemory();
		const empty = { extensions: [], skills: [], prompts: [], themes: [] };
		const resolved: ScopedResolvedPaths = {
			global: {
				...empty,
				skills: [
					{
						path: skillPath,
						enabled: false,
						metadata: { source: "auto", scope: "user", origin: "top-level", baseDir: "C:/demo/.candy" },
					},
				],
			},
			project: empty,
		};
		const selector = new ConfigSelectorComponent(
			resolved,
			settings,
			"C:/demo",
			"C:/demo/.candy",
			() => {},
			() => {},
			() => {},
			24,
			"global",
			false,
			undefined,
			{
				resourceTypes: ["skills"],
				beforeToggle: () => "Wait for the current response to finish.",
			},
		);
		selector.getResourceList().handleInput(" ");
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("Wait for the current response to finish.");
		await settings.flush();
		expect(settings.getGlobalSettings().skills).toBeUndefined();
	});

	it("routes Space to the search input and renders tightly in embedded mode", () => {
		initTheme("dark");
		const selector = createSelector({ embedded: true, title: "Skills" });
		const list = selector.getResourceList();
		const listLines = list.render(80);
		const searchRow = listLines.length - 1;
		const click: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 0,
			y: searchRow,
			screenX: 0,
			screenY: searchRow,
			width: 80,
			height: listLines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		list.handleMouse(click);
		list.handleInput(" ");
		expect(stripAnsi(selector.render(80).join("\n"))).not.toContain("Skills Skills");
		const rendered = selector.render(80).map(stripAnsi);
		expect(rendered.join("\n")).toContain("[ ] review");
		expect(rendered.join("\n")).not.toMatch(/[╭╮╰╯┌┐└┘]/);
		expect(rendered.length).toBeLessThan(12);
	});
});
