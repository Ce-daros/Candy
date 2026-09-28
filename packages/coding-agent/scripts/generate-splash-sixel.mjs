// Generates splash-logo.generated.ts from assets/candy-v3.png:
// - SIXEL_SEQUENCE: candy-v3.png pre-encoded as a Sixel graphics sequence (build-time
//   baked, zero runtime decoding) for terminals with Sixel support (Windows Terminal).
// - SPRITE_GRID / SPRITE_PALETTE: a Unicode half-block pixel sprite used as the
//   fallback for terminals without image protocols.
//
// Run: node scripts/generate-splash-sixel.mjs  (from packages/coding-agent)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PhotonImage } from "@silvia-odwyer/photon-node";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const srcPath = path.join(pkgRoot, "assets", "candy-v3.png");
const outPath = path.join(pkgRoot, "src", "modes", "interactive", "components", "splash-logo.generated.ts");

const SIXEL_SCALE = 4;

// Sprite: 56 columns of half-block cells (fits an 80-column terminal with room to spare).
const SPRITE_COLUMNS = 56;

const MAX_COLORS = 16;

const PNG = PhotonImage.new_from_byteslice(new Uint8Array(readFileSync(srcPath)));
const srcW = PNG.get_width();
const srcH = PNG.get_height();
const raw = PNG.get_raw_pixels();
const px = (x, y) => {
	const i = (y * srcW + x) * 4;
	return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
};
const isEmptyPixel = (_r, _g, _b, a) => a === 0;

const colorCounts = new Map();
for (let i = 0; i < raw.length; i += 4) {
	if (isEmptyPixel(raw[i], raw[i + 1], raw[i + 2], raw[i + 3])) continue;
	if (raw[i + 3] !== 255) throw new Error("Sixel splash requires fully opaque or transparent source pixels");
	const key = (raw[i] << 16) | (raw[i + 1] << 8) | raw[i + 2];
	colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
}
const hex = (key) => [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff];
if (colorCounts.size > MAX_COLORS) throw new Error(`Sixel splash has ${colorCounts.size} colors; sprite supports ${MAX_COLORS}`);
const PALETTE = [...colorCounts].sort((a, b) => b[1] - a[1]).map(([key]) => hex(key));
const paletteIndex = new Map(PALETTE.map(([r, g, b], index) => [(r << 16) | (g << 8) | b, index]));

// --- content bounding box (skip transparent / near-black background) ---
let minX = srcW, minY = srcH, maxX = 0, maxY = 0;
for (let y = 0; y < srcH; y++) {
	for (let x = 0; x < srcW; x++) {
		const [r, g, b, a] = px(x, y);
		if (!isEmptyPixel(r, g, b, a)) {
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
}
const bw = maxX - minX + 1;
const bh = maxY - minY + 1;

function classify(r, g, b) {
	let best = 0, bestD = Infinity;
	for (let i = 0; i < PALETTE.length; i++) {
		const [pr, pg, pb] = PALETTE[i];
		const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
		if (d < bestD) {
			bestD = d;
			best = i;
		}
	}
	return best;
}

const CANVAS_W = srcW * SIXEL_SCALE;
const CANVAS_H = srcH * SIXEL_SCALE;

function encodeSixel() {
	// `0;1;0`: P2=1 selects "do not fill the background", so pixels the image does
	// not plot stay transparent and the logo sits on the terminal's own background.
	// With P2 left at its default of 0 the terminal first paints the whole image
	// rectangle with its default background color, which shows up as a black box
	// behind the logo on any scheme whose background is not black.
	let out = `\x1bP0;1;0q"1;1;${CANVAS_W};${CANVAS_H}`;
	PALETTE.forEach(([r, g, b], i) => {
		out += `#${i};2;${Math.round((r / 255) * 100)};${Math.round((g / 255) * 100)};${Math.round((b / 255) * 100)}`;
	});
	const bands = Math.ceil(CANVAS_H / 6);
	for (let band = 0; band < bands; band++) {
		if (band > 0) out += "-";
		// Each color gets its own pass over the band; `$` returns the cursor to
		// column 0 without advancing a line, and plotting overlays (bits set by a
		// later pass win). The cursor advances one column per sixel character,
		// including transparent ones (0x3f), so transparent runs are emitted as
		// `!n?` repeats rather than skipped.
		let passesInBand = 0;
		for (let colorIndex = 0; colorIndex < PALETTE.length; colorIndex++) {
			const chars = [];
			let any = false;
			for (let x = 0; x < CANVAS_W; x++) {
				let bits = 0;
				for (let row = 0; row < 6; row++) {
					const py = band * 6 + row;
					if (py >= CANVAS_H) break;
					const [r, g, b, a] = px(Math.floor(x / SIXEL_SCALE), Math.floor(py / SIXEL_SCALE));
					if (isEmptyPixel(r, g, b, a)) continue;
					if (paletteIndex.get((r << 16) | (g << 8) | b) === colorIndex) {
						bits |= 1 << row;
						any = true;
					}
				}
				chars.push(bits);
			}
			if (!any) continue;
			if (passesInBand > 0) out += "$";
			out += `#${colorIndex}`;
			let j = 0;
			while (j < chars.length) {
				const ch = chars[j];
				let k = j;
				while (k < chars.length && chars[k] === ch) k++;
				const run = k - j;
				if (ch === 0) {
					out += run > 2 ? `!${run}?` : "?".repeat(run);
				} else {
					const c = String.fromCharCode(0x3f + ch);
					out += run > 2 ? `!${run}${c}` : c.repeat(run);
				}
				j = k;
			}
			passesInBand++;
		}
	}
	return out + "\x1b\\";
}

const sixelSequence = encodeSixel();

// --- Sprite: majority-vote downsample of the source bbox, then isolate-pixel cleanup ---
const spriteRows = Math.max(2, Math.round((SPRITE_COLUMNS * bh) / bw / 2) * 2);
const grid = [];
for (let gy = 0; gy < spriteRows; gy++) {
	const row = [];
	for (let gx = 0; gx < SPRITE_COLUMNS; gx++) {
		const x0 = minX + Math.floor((gx * bw) / SPRITE_COLUMNS);
		const x1 = minX + Math.floor(((gx + 1) * bw) / SPRITE_COLUMNS);
		const y0 = minY + Math.floor((gy * bh) / spriteRows);
		const y1 = minY + Math.floor(((gy + 1) * bh) / spriteRows);
		const votes = new Array(PALETTE.length).fill(0);
		let empty = 0, total = 0;
		for (let y = y0; y < Math.max(y1, y0 + 1); y++) {
			for (let x = x0; x < Math.max(x1, x0 + 1); x++) {
				const [r, g, b, a] = px(x, y);
				total++;
				if (isEmptyPixel(r, g, b, a)) {
					empty++;
					continue;
				}
				votes[classify(r, g, b)]++;
			}
		}
		row.push(empty > total * 0.55 ? -1 : votes.indexOf(Math.max(...votes)));
	}
	grid.push(row);
}
// Replace cells whose 8 neighbors mostly agree on a different color.
for (let y = 0; y < spriteRows; y++) {
	for (let x = 0; x < SPRITE_COLUMNS; x++) {
		const counts = new Map();
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (dx === 0 && dy === 0) continue;
				const ny = y + dy, nx = x + dx;
				if (ny < 0 || ny >= spriteRows || nx < 0 || nx >= SPRITE_COLUMNS) continue;
				const v = grid[ny][nx];
				counts.set(v, (counts.get(v) ?? 0) + 1);
			}
		}
		const self = grid[y][x];
		let bestV = self, bestN = 0;
		for (const [v, n] of counts) if (n > bestN) { bestN = n; bestV = v; }
		if (bestV !== self && bestN >= 6) grid[y][x] = bestV;
	}
}
const HEX = "0123456789ABCDEF";
const spriteGrid = grid.map((row) => row.map((v) => (v === -1 ? "." : HEX[v])).join("")).join("\n");

const generated = `// Generated by scripts/generate-splash-sixel.mjs from assets/candy-v3.png. Do not edit.

/** Pre-encoded Sixel sequence (DCS...ST) of the Candy logo, ${CANVAS_W}x${CANVAS_H} px. */
export const SIXEL_SEQUENCE = ${JSON.stringify(sixelSequence)};
export const SIXEL_WIDTH_PX = ${CANVAS_W};
export const SIXEL_HEIGHT_PX = ${CANVAS_H};

/** Unicode half-block sprite fallback: hex palette index per cell, '.' = empty. */
export const SPRITE_COLUMNS = ${SPRITE_COLUMNS};
export const SPRITE_ROWS = ${spriteRows};
export const SPRITE_GRID = ${JSON.stringify(spriteGrid)};
export const SPRITE_PALETTE: readonly (readonly [number, number, number])[] = ${JSON.stringify(PALETTE)};
`;

writeFileSync(outPath, generated);
console.log(`wrote ${outPath}`);
console.log(`sixel: ${sixelSequence.length} chars, canvas ${CANVAS_W}x${CANVAS_H}`);
console.log(`sprite: ${SPRITE_COLUMNS}x${spriteRows} cells`);
console.log(`palette: ${PALETTE.length} colors (source ${srcW}x${srcH})`);
console.log(`  ${PALETTE.map((c) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`).join(" ")}`);
