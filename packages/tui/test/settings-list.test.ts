import assert from "node:assert";
import { describe, it } from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import type { TuiMouseEvent } from "../src/tui.ts";

const testTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
	keycap: (key) => `<${key}>`,
};

const items = [
	{
		id: "tui-mode",
		label: "TUI mode",
		currentValue: "regular",
		values: ["regular", "fullscreen"],
	},
];

describe("SettingsList", () => {
	it("passes focus to a submenu and restores search on return", () => {
		let close!: () => void;
		const submenu = {
			focused: false,
			invalidate() {},
			render: () => ["submenu"],
		};
		const list = new SettingsList(
			[
				{
					id: "theme",
					label: "Theme",
					currentValue: "dark",
					submenu: (_value, done) => {
						close = done;
						return submenu;
					},
				},
			],
			5,
			testTheme,
			() => {},
			() => {},
			{ enableSearch: true },
		);
		list.focused = true;
		list.handleInput("\r");
		assert.equal(submenu.focused, true);
		close();
		assert.equal(submenu.focused, false);
		assert.ok(list.render(80).join("\n").includes("Theme"));
	});
	it("includes spaces in an active search instead of changing the selected setting", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => {
				changes.push({ id, value });
			},
			() => {},
			{ enableSearch: true },
		);

		for (const character of "TUI mode") list.handleInput(character);

		assert.deepStrictEqual(changes, []);
		assert.match(list.render(80)[0] ?? "", /TUI mode/);

		list.handleInput("\r");
		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
		list.updateValue("tui-mode", "fullscreen");
		list.handleInput("\r");
		assert.deepStrictEqual(changes[1], { id: "tui-mode", value: "regular" });
	});

	it("keeps Space as a change shortcut before a search query is entered", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => {
				changes.push({ id, value });
			},
			() => {},
			{ enableSearch: true },
		);

		list.handleInput(" ");

		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("stops keyboard and wheel navigation at the first and last settings", () => {
		const list = new SettingsList(
			[
				{ id: "first", label: "First", currentValue: "off", values: ["off", "on"] },
				{ id: "second", label: "Second", currentValue: "off", values: ["off", "on"] },
			],
			10,
			testTheme,
			() => {},
			() => {},
		);
		list.handleInput("\x1b[A");
		assert.equal(list.getSelectedItem()?.id, "first");
		list.handleInput("\x1b[B");
		assert.equal(list.getSelectedItem()?.id, "second");
		list.handleInput("\x1b[B");
		assert.equal(list.getSelectedItem()?.id, "second");

		const wheel: TuiMouseEvent = {
			type: "wheel",
			button: "none",
			x: 0,
			y: 0,
			screenX: 0,
			screenY: 0,
			width: 80,
			height: 10,
			wheelDelta: 1,
			shift: false,
			alt: false,
			ctrl: false,
		};
		list.handleMouse(wheel);
		assert.equal(list.getSelectedItem()?.id, "second");
	});

	it("restores the previous value and renders async save failures", async () => {
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			async () => {
				throw new Error("Could not save settings");
			},
			() => {},
		);

		list.handleInput("\r");
		await new Promise((resolve) => setImmediate(resolve));

		assert.match(list.render(80).join("\n"), /Error: Could not save settings/);
		assert.match(list.render(80)[0] ?? "", /regular/);
	});
});
