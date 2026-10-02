import { dirname, resolve } from "node:path";
import { setKeybindings, visibleWidth } from "@candy/tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { KeybindingsManager } from "../src/presentation/keybindings.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("TrustSelectorComponent", () => {
	it.each([80, 120])("keeps long Chinese paths and the action hints visible at width %s", (width) => {
		const cwd = resolve(`/${"很长的父目录/".repeat(20)}末尾项目`);
		const selector = new TrustSelectorComponent({
			cwd,
			savedDecision: { path: dirname(cwd), decision: true },
			projectTrusted: true,
			includeSessionOnly: true,
			onSelect: () => {},
			onCancel: () => {},
		});
		const lines = selector.render(width);
		expect(lines.length).toBeLessThanOrEqual(24);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(stripAnsi(lines[1]!)).toContain("末尾项目");
		expect(stripAnsi(lines.at(-1)!)).toContain("save");
		expect(stripAnsi(lines.at(-1)!)).toContain("cancel");
		expect(stripAnsi(lines.join("\n"))).toContain("Do not trust (this session only)");
	});
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("keeps the saved trusted decision marked while browsing", () => {
		const cwd = resolve("/project");
		const selector = new TrustSelectorComponent({
			cwd,
			savedDecision: { path: cwd, decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		let output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain(`Saved decision: trusted (${cwd})`);
		expect(output).toContain("Current session: trusted");
		expect(output).toContain("♦ ✓ Trust ♦");
		expect(output).toContain(`${cwd} · saved`);

		selector.handleInput("\x1b[B");
		output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("✓ Trust");
		expect(output).toContain(`♦   Trust parent folder (${dirname(cwd)}) ♦`);
		expect(output).not.toContain("✓ Do not trust");
	});

	it("selects a trust decision", () => {
		const cwd = resolve("/project");
		const onSelect = vi.fn();
		const selector = new TrustSelectorComponent({
			cwd,
			savedDecision: null,
			projectTrusted: false,
			onSelect,
			onCancel: () => {},
		});

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({ trusted: true, updates: [{ path: cwd, decision: true }] });
	});

	it("labels saved ancestor decisions as inherited", () => {
		const cwd = resolve("/parent/project/nested");
		const parent = resolve("/parent");
		const selector = new TrustSelectorComponent({
			cwd,
			savedDecision: { path: parent, decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain(`Saved decision: trusted (inherited from ${parent})`);
	});

	it("adds a trust parent option", () => {
		const cwd = resolve("/parent/project");
		const parent = dirname(cwd);
		const onSelect = vi.fn();
		const selector = new TrustSelectorComponent({
			cwd,
			savedDecision: { path: parent, decision: true },
			projectTrusted: true,
			onSelect,
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain(`Saved decision: trusted (inherited from ${parent})`);
		expect(output).toContain(`✓ Trust parent folder (${parent})`);

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({
			trusted: true,
			updates: [
				{ path: parent, decision: true },
				{ path: cwd, decision: null },
			],
		});
	});
});
