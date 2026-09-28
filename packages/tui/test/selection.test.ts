import assert from "node:assert";
import { describe, it } from "node:test";
import { moveSelection, moveViewport } from "../src/selection.ts";

describe("selection state helpers", () => {
	it("wraps keyboard movement and bounds pointer movement", () => {
		assert.equal(moveSelection(0, 3, -1, true), 2);
		assert.equal(moveSelection(2, 3, 1, true), 0);
		assert.equal(moveSelection(0, 3, -1), 0);
		assert.equal(moveSelection(2, 3, 1), 2);
		assert.equal(moveSelection(0, 0, 1, true), 0);
	});

	it("keeps a text viewport within its content", () => {
		assert.equal(moveViewport(3, 20, 5, 2), 5);
		assert.equal(moveViewport(3, 20, 5, -8), 0);
		assert.equal(moveViewport(0, 3, 5, 2), 0);
	});
});
