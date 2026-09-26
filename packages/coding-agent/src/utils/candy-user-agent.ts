export function getCandyUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `candy/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
