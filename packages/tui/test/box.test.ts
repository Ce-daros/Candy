import assert from "node:assert";
import { it } from "node:test";
import { Box } from "../src/components/box.ts";

it("preserves padding and refreshes cached lines when background output changes", () => {
	let background = "a";
	const box = new Box(1, 1, (text) => `${background}:${text}`);
	box.addChild({ render: () => ["hello"], invalidate() {} });
	const first = box.render(10);
	assert.deepStrictEqual(first, ["a:          ", "a: hello    ", "a:          "]);
	assert.strictEqual(box.render(10), first);
	background = "b";
	assert.deepStrictEqual(box.render(10), ["b:          ", "b: hello    ", "b:          "]);
});
