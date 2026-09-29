export function moveSelection(index: number, count: number, delta: number, wrap = false): number {
	if (count === 0) return 0;
	if (wrap) return (((index + delta) % count) + count) % count;
	return Math.max(0, Math.min(count - 1, index + delta));
}

export function moveViewport(offset: number, lineCount: number, viewportHeight: number, delta: number): number {
	return Math.max(0, Math.min(Math.max(0, lineCount - viewportHeight), offset + delta));
}

/** Render-time window over a flat list that keeps the selection in view, centered when possible. */
export function visibleWindow(index: number, count: number, viewportSize: number): { start: number; end: number } {
	if (viewportSize <= 0) return { start: 0, end: 0 };
	const start = Math.max(0, Math.min(index - Math.floor(viewportSize / 2), count - viewportSize));
	return { start, end: Math.min(start + viewportSize, count) };
}
