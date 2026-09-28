import { valid, validRange } from "semver";
import { type GitSource, parseGitUrl } from "../utils/git.ts";
import { isLocalPath } from "../utils/paths.ts";

export interface NpmSource {
	type: "npm";
	spec: string;
	name: string;
	version?: string;
	range?: string;
	pinned: boolean;
}

export interface LocalSource {
	type: "local";
	path: string;
}

export type ParsedSource = NpmSource | GitSource | LocalSource;

function parseNpmSpec(spec: string): { name: string; version?: string } {
	const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	if (!match) return { name: spec };
	return { name: match[1] ?? spec, version: match[2] };
}

export function parsePackageSource(source: string): ParsedSource {
	if (source.startsWith("npm:")) {
		const spec = source.slice("npm:".length).trim();
		const { name, version } = parseNpmSpec(spec);
		return {
			type: "npm",
			spec,
			name,
			version,
			range: version ? (validRange(version) ?? undefined) : undefined,
			pinned: valid(version ?? "") !== null,
		};
	}

	if (isLocalPath(source)) return { type: "local", path: source };

	const gitSource = parseGitUrl(source);
	return gitSource ?? { type: "local", path: source };
}
