import assert from "node:assert";
import { describe, it } from "node:test";
import { SelectList } from "../src/components/select-list.ts";
import { visibleWidth } from "../src/utils.ts";

const testTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

const visibleIndexOf = (line: string, text: string): number => {
	const index = line.indexOf(text);
	assert.notEqual(index, -1);
	return visibleWidth(line.slice(0, index));
};

describe("SelectList", () => {
	it("normalizes multiline descriptions to single line", () => {
		const items = [
			{
				value: "test",
				label: "test",
				description: "Line one\nLine two\nLine three",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(100);

		assert.ok(rendered.length > 0);
		assert.ok(!rendered[0].includes("\n"));
		assert.ok(rendered[0].includes("Line one Line two Line three"));
	});

	it("keeps descriptions aligned when the primary text is truncated", () => {
		const items = [
			{ value: "short", label: "short", description: "short description" },
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "long description",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "short description"), visibleIndexOf(rendered[1], "long description"));
	});

	it("uses the configured minimum primary column width", () => {
		const items = [
			{ value: "a", label: "a", description: "first" },
			{ value: "bb", label: "bb", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(rendered[0].indexOf("first"), 14);
		assert.equal(rendered[1].indexOf("second"), 14);
	});

	it("uses the configured maximum primary column width", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "first"), 22);
		assert.equal(visibleIndexOf(rendered[1], "second"), 22);
	});

	it("allows overriding primary truncation while preserving description alignment", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 12,
			truncatePrimary: ({ text, maxWidth }) => {
				if (text.length <= maxWidth) {
					return text;
				}

				return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
			},
		});
		const rendered = list.render(80);

		assert.ok(rendered[0].includes("…"));
		assert.equal(visibleIndexOf(rendered[0], "first"), visibleIndexOf(rendered[1], "second"));
	});

	it("keeps right-aligned directories stable when selection moves", () => {
		const list = new SelectList(
			[
				{ value: "first.ts", label: "first.ts", description: "src/components/" },
				{ value: "second.ts", label: "second.ts", description: "src/components/" },
			],
			5,
			testTheme,
			{ descriptionAlign: "right", selectedDetail: (item) => `src/components/${item.value}` },
		);
		const before = list.render(80);
		list.setSelectedIndex(1);
		const after = list.render(80);
		assert.equal(visibleIndexOf(before[0], "src/components/"), visibleIndexOf(after[0], "src/components/"));
		assert.equal(visibleIndexOf(before[1], "src/components/"), visibleIndexOf(after[1], "src/components/"));
		assert.equal(after[2], "src/components/second.ts");
		assert.ok([...before, ...after].every((line) => visibleWidth(line) <= 80));
	});

	it("skips non-selectable group labels during keyboard navigation", () => {
		const list = new SelectList(
			[
				{ value: "group", label: "Connection", selectable: false },
				{ value: "first", label: "First" },
				{ value: "second", label: "Second" },
			],
			5,
			testTheme,
		);
		list.setSelectedIndex(0);
		assert.equal(list.getSelectedItem()?.value, "first");
		list.handleInput("\x1b[B");
		assert.equal(list.getSelectedItem()?.value, "second");
	});

	it("preserves ANSI styling already present in inline descriptions", () => {
		const styled = "\u001b[31mNot connected\u001b[0m";
		const list = new SelectList([{ value: "provider", label: "Provider", description: styled }], 5, testTheme);
		assert.ok(list.render(80)[0].includes(styled));
	});
});
