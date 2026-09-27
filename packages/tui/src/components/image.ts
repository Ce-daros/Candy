import {
	allocateImageId,
	getCapabilities,
	getCellDimensions,
	getImageDimensions,
	type ImageDimensions,
	imageFallback,
	renderImage,
} from "../terminal-image.ts";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	/** Kitty image ID. If provided, reuses this ID (for animations/updates). */
	imageId?: number;
	viewportRows?: number;
}

export class Image implements Component {
	private base64Data: string;
	private mimeType: string;
	private dimensions: ImageDimensions;
	private theme: ImageTheme;
	private options: ImageOptions;
	private imageId?: number;
	private expanded = false;

	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.base64Data = base64Data;
		this.mimeType = mimeType;
		this.theme = theme;
		this.options = options;
		this.dimensions = dimensions || getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
		this.imageId = options.imageId;
	}

	/** Get the Kitty image ID used by this image (if any). */
	getImageId(): number | undefined {
		return this.imageId;
	}

	setViewportRows(rows: number): void {
		if (this.options.viewportRows === rows) return;
		this.options.viewportRows = rows;
		this.invalidate();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.invalidate();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
		this.setExpanded(!this.expanded);
		return { handled: true };
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const maxWidth = Math.max(1, Math.min(width - 2, this.options.maxWidthCells ?? 60));
		const cellDimensions = getCellDimensions();
		const defaultMaxHeight = Math.max(1, Math.ceil((maxWidth * cellDimensions.widthPx) / cellDimensions.heightPx));
		const viewportRows = this.options.viewportRows ?? process.stdout.rows ?? 24;
		const viewportLimit = Math.max(1, Math.floor((viewportRows * (this.expanded ? 2 : 1)) / 3));
		const maxHeight = Math.min(this.options.maxHeightCells ?? defaultMaxHeight, viewportLimit);

		const caps = getCapabilities();
		let lines: string[];

		if (caps.images) {
			if (caps.images === "kitty" && this.imageId === undefined) {
				this.imageId = allocateImageId();
			}
			const result = renderImage(this.base64Data, this.dimensions, {
				maxWidthCells: maxWidth,
				maxHeightCells: maxHeight,
				imageId: this.imageId,
				moveCursor: false,
			});

			if (result) {
				// Store the image ID for later cleanup
				if (result.imageId) {
					this.imageId = result.imageId;
				}

				if (caps.images === "kitty") {
					// For Kitty: C=1 prevents cursor movement.
					// Don't need the cursor movement.
					lines = [result.sequence];

					// Return `rows` lines so TUI accounts for image height.
					for (let i = 0; i < result.rows - 1; i++) {
						lines.push("");
					}
				} else {
					// Return `rows` lines so TUI accounts for image height.
					// First (rows-1) lines are empty and cleared before the image is drawn.
					// Last line: move cursor back up, draw the image, then move back down
					// so TUI cursor accounting stays inside the scroll area.
					lines = [];
					for (let i = 0; i < result.rows - 1; i++) {
						lines.push("");
					}
					const rowOffset = result.rows - 1;
					const moveUp = rowOffset > 0 ? `\x1b[${rowOffset}A` : "";
					lines.push(moveUp + result.sequence);
				}
			} else {
				const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
				lines = [truncateToWidth(this.theme.fallbackColor(fallback), width)];
			}
		} else {
			const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
			lines = [truncateToWidth(this.theme.fallbackColor(fallback), width)];
		}

		const title = `${this.options.filename ?? "Image"}  ${this.dimensions.widthPx}×${this.dimensions.heightPx}`;
		lines.unshift(truncateToWidth(this.theme.fallbackColor(title), width));
		this.cachedLines = lines;
		this.cachedWidth = width;

		return lines;
	}
}
