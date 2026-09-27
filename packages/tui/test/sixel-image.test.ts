import assert from "node:assert";
import { describe, it } from "node:test";
import { SixelImage } from "../src/components/sixel-image.ts";
import { setCellDimensions } from "../src/terminal-image.ts";

describe("SixelImage", () => {
	it("should reserve rows for the image height and center the sequence", () => {
		try {
			setCellDimensions({ widthPx: 10, heightPx: 20 });
			const image = new SixelImage("\x1bPq!5@\x1b\\", 80, 100);
			const lines = image.render(40);
			// 100px / 20px cell = 5 rows; 80px / 10px cell = 8 columns; pad = (40-8)/2 = 16
			assert.strictEqual(lines.length, 5);
			assert.strictEqual(lines[0], "\x1b[16C\x1bPq!5@\x1b\\");
			for (let i = 1; i < 5; i++) {
				assert.strictEqual(lines[i], "");
			}
		} finally {
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("should not pad when the image is wider than the terminal", () => {
		try {
			setCellDimensions({ widthPx: 10, heightPx: 20 });
			const image = new SixelImage("\x1bPq!5@\x1b\\", 200, 20);
			const lines = image.render(10);
			assert.strictEqual(lines.length, 1);
			assert.strictEqual(lines[0], "\x1bPq!5@\x1b\\");
		} finally {
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("should cache lines per width and invalidate", () => {
		try {
			setCellDimensions({ widthPx: 10, heightPx: 20 });
			const image = new SixelImage("\x1bPq!5@\x1b\\", 80, 100);
			const first = image.render(40);
			assert.strictEqual(image.render(40), first);
			image.invalidate();
			const second = image.render(40);
			assert.notStrictEqual(second, first);
			assert.deepStrictEqual(second, first);
		} finally {
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});
});
