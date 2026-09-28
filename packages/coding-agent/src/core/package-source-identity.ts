import { parsePackageSource } from "./package-source.ts";

export function packageSourceIdentity(source: string, resolveLocalPath: (path: string) => string): string {
	const parsed = parsePackageSource(source);
	if (parsed.type === "npm") return `npm:${parsed.name}`;
	if (parsed.type === "git") return `git:${parsed.host}/${parsed.path}`;
	return `local:${resolveLocalPath(parsed.path)}`;
}
