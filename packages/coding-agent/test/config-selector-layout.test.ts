import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	ConfigSelectorComponent,
	type ScopedResolvedPaths,
} from "../src/modes/interactive/components/config-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("ConfigSelectorComponent viewport", () => {
	it("keeps categories, resource detail, and search visible at 80 by 24 and after resize", () => {
		initTheme("dark");
		let rows = 24;
		const paths = {
			extensions: [
				{
					path: "C:/demo/.candy/extensions/example.ts",
					enabled: true,
					metadata: {
						source: "npm:candy-tools",
						scope: "user" as const,
						origin: "package" as const,
						baseDir: "C:/demo/.candy",
					},
				},
			],
			skills: [],
			prompts: [],
			themes: [],
		};
		const scoped: ScopedResolvedPaths = { global: paths, project: paths };
		const selector = new ConfigSelectorComponent(
			scoped,
			SettingsManager.inMemory(),
			"C:/demo",
			"C:/demo/.candy",
			() => {},
			() => {},
			() => {},
			rows,
			"global",
			true,
			() => Math.floor(rows * 0.8),
		);
		const compact = selector.render(80);
		const text = stripAnsi(compact.join("\n"));
		expect(compact.length).toBeLessThanOrEqual(rows);
		expect(text).toContain("Extensions");
		expect(text).toContain("example.ts");
		expect(text).toContain("C:/demo/.candy/extensions/example.ts");
		rows = 45;
		expect(selector.render(160).length).toBeGreaterThan(compact.length);
	});
});
