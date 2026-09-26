import { visibleWidth } from "@candy/tui";
import { describe, expect, it } from "vitest";
import { TopBarComponent } from "../src/modes/interactive/components/top-bar.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function renderBar(width: number, data: { project: string; branch?: string | null; sessionName?: string }): string {
	initTheme("dark");
	return (
		new TopBarComponent(() => ({
			project: data.project,
			branch: data.branch ?? null,
			sessionName: data.sessionName,
		})).render(width)[0] ?? ""
	);
}

describe("TopBarComponent", () => {
	it("renders the title, project/branch, fill, and session name across the full width", () => {
		const line = renderBar(60, { project: "candy", branch: "main", sessionName: "fix bug" });
		expect(line).toContain("Candy");
		expect(line).toContain("candy/main");
		expect(line).toContain("fix bug");
		expect(visibleWidth(line)).toBe(60);
	});

	it("omits the branch when there is no repository", () => {
		const line = renderBar(40, { project: "candy" });
		expect(line).toContain("candy");
		expect(line).not.toContain("/");
		expect(visibleWidth(line)).toBe(40);
	});

	it("fills the remaining width with dashes when there is no session name", () => {
		const line = renderBar(40, { project: "candy", branch: "main" });
		expect(line).toContain("candy/main");
		expect(visibleWidth(line)).toBe(40);
	});

	it("truncates the project segment to keep the session name", () => {
		const project = "a-very-long-project-name-that-overflows";
		const line = renderBar(30, { project, branch: "main", sessionName: "session" });
		expect(line).toContain("…");
		expect(line).toContain("session");
		expect(visibleWidth(line)).toBe(30);
	});
});
