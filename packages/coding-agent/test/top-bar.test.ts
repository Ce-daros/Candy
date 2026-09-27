import { visibleWidth } from "@candy/tui";
import { describe, expect, it } from "vitest";
import { TopBarComponent } from "../src/modes/interactive/components/top-bar.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function renderBar(
	width: number,
	data: { project: string; branch?: string | null; sessionName?: string; percent?: number | null },
): string {
	initTheme("dark");
	return stripAnsi(
		new TopBarComponent(() => ({
			project: data.project,
			branch: data.branch ?? null,
			sessionName: data.sessionName,
			contextPercent: data.percent ?? null,
		})).render(width)[0] ?? "",
	);
}

function lineLength(bar: string): number {
	return bar.match(/Candy\/main (─*)/)?.[1]?.length ?? 0;
}

describe("TopBarComponent", () => {
	it("grows one plain line with context usage", () => {
		const data = { project: "Candy", branch: "main" };
		const low = renderBar(60, { ...data, percent: 10 });
		const middle = renderBar(60, { ...data, percent: 50 });
		const high = renderBar(60, { ...data, percent: 90 });
		expect(lineLength(low)).toBeLessThan(lineLength(middle));
		expect(lineLength(middle)).toBeLessThan(lineLength(high));
		for (const bar of [low, middle, high]) {
			expect(bar).not.toMatch(/\d+%|━|┄|╾|Context/);
			expect(visibleWidth(bar)).toBe(60);
		}
	});

	it("uses the width left by the workspace and session name", () => {
		const short = renderBar(60, { project: "Candy", branch: "main", sessionName: "fix bug", percent: 100 });
		const long = renderBar(60, {
			project: "much-longer-project",
			branch: "main",
			sessionName: "fix bug",
			percent: 100,
		});
		expect(short).toContain("Candy/main");
		expect(short).toContain("fix bug");
		expect(long).toContain("much-longer-project/main");
		expect(long).toContain("fix bug");
		expect(short.match(/main (─*)/)?.[1].length ?? 0).toBeGreaterThan(long.match(/main (─*)/)?.[1].length ?? 0);
	});

	it("keeps the workspace identity ahead of the session name in a narrow terminal", () => {
		const bar = renderBar(25, { project: "Candy", branch: "main", sessionName: "long session name", percent: 100 });
		expect(bar).toContain("Candy ─ Candy/main");
		expect(visibleWidth(bar)).toBe(25);
	});

	it("recalculates the line after project and branch changes", () => {
		let project = "Candy";
		let branch = "main";
		const bar = new TopBarComponent(() => ({ project, branch, sessionName: undefined, contextPercent: 50 }));
		const first = stripAnsi(bar.render(60)[0]);
		project = "longer-workspace-name";
		branch = "feature/context-line";
		const second = stripAnsi(bar.render(60)[0]);
		expect(first).toContain("Candy/main");
		expect(second).toContain("longer-workspace-name/feature/context-line");
		expect(visibleWidth(first)).toBe(60);
		expect(visibleWidth(second)).toBe(60);
		expect(second.match(/line (─*)/)?.[1].length ?? 0).toBeLessThan(lineLength(first));
	});

	it("fits terminal widths too small for the full title", () => {
		for (const width of [1, 2, 5, 8, 12]) {
			expect(visibleWidth(renderBar(width, { project: "Candy", branch: "main", percent: 100 }))).toBe(width);
		}
	});

	it("only truncates the workspace when it alone exceeds the width", () => {
		const bar = renderBar(30, {
			project: "a-very-long-project-name-that-overflows",
			branch: "main",
			sessionName: "session",
			percent: 80,
		});
		expect(bar).toContain("a-very-long-project");
		expect(bar).toContain("…");
		expect(visibleWidth(bar)).toBe(30);
	});

	it("shows no context line when usage is unavailable", () => {
		const bar = renderBar(40, { project: "Candy", branch: "main" });
		expect(lineLength(bar)).toBe(0);
		expect(visibleWidth(bar)).toBe(40);
	});

	it("omits the branch outside a git repository", () => {
		const bar = renderBar(40, { project: "Candy", percent: 50 });
		expect(bar).toContain("Candy ─ Candy ");
		expect(bar).not.toContain("/");
	});
});
