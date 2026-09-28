export function moveSelection(index: number, count: number, delta: number, wrap = false): number {
	if (count === 0) return 0;
	if (wrap) return (((index + delta) % count) + count) % count;
	return Math.max(0, Math.min(count - 1, index + delta));
}

export function moveViewport(offset: number, lineCount: number, viewportHeight: number, delta: number): number {
	return Math.max(0, Math.min(Math.max(0, lineCount - viewportHeight), offset + delta));
}
