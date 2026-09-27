import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { Input } from "../src/components/input.ts";
import { visibleWidth } from "../src/utils.ts";

describe("secret input", () => {
	it("masks every visible character without changing submitted content", () => {
		const input = new Input({ mask: true });
		input.handleInput("sk-secret-中文🔐");
		for (const width of [8, 20, 80]) {
			const rendered = stripAnsi(input.render(width)[0]);
			assert.ok(!rendered.includes("secret"));
			assert.ok(!rendered.includes("中文"));
			assert.equal(visibleWidth(rendered), width);
		}
		let submitted = "";
		input.onSubmit = (value) => {
			submitted = value;
		};
		input.handleInput("\r");
		assert.equal(submitted, "sk-secret-中文🔐");
	});

	it("restores ordinary rendering when the next prompt is public", () => {
		const input = new Input({ mask: true });
		input.setValue("key");
		input.setMasked(false);
		input.setValue("device-code");
		assert.match(stripAnsi(input.render(30)[0]), /device-code/);
	});
});
