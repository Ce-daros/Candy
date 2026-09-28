import type { Extension } from "../extensions/types.ts";

type ExtensionStackMetadata = Pick<Extension, "path" | "resolvedPath" | "sourceInfo">;

function normalizeStackPath(value: string): string {
	return value.replace(/\\/g, "/").replace(/\/+$/u, "");
}

function stackContainsPath(stack: string, targetPath: string, includeDescendants: boolean): boolean {
	const target = normalizeStackPath(targetPath);
	if (!target || target.startsWith("<")) return false;
	const caseInsensitive = /^[a-z]:\//iu.test(target);
	const haystack = caseInsensitive ? stack.toLowerCase() : stack;
	const needle = caseInsensitive ? target.toLowerCase() : target;
	if (includeDescendants) return haystack.includes(`${needle}/`);

	let index = haystack.indexOf(needle);
	while (index !== -1) {
		const next = haystack[index + needle.length];
		if (next === undefined || next === ":" || next === ")" || /\s/u.test(next)) return true;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return false;
}

/** Find loaded extensions with source files in a stack trace. */
export function findExtensionStackMatches(
	stack: string | undefined,
	extensions: readonly ExtensionStackMetadata[],
): string[] {
	if (!stack) return [];
	const normalizedStack = stack
		.split("\n")
		.slice(1)
		.filter((line) => /^\s+at\s/u.test(line))
		.map((line) => {
			try {
				return decodeURI(line);
			} catch {
				return line;
			}
		})
		.join("\n")
		.replace(/\\/g, "/");
	const matches: string[] = [];
	const seen = new Set<string>();

	for (const extension of extensions) {
		const resolvedPath = normalizeStackPath(extension.resolvedPath);
		const singleFilePackage =
			extension.sourceInfo.origin === "package" &&
			!/^(?:npm:|git:|https?:\/\/|ssh:\/\/)/u.test(extension.sourceInfo.source) &&
			/\.[cm]?[jt]s$/u.test(extension.sourceInfo.source);
		const packageRoot =
			extension.sourceInfo.origin === "package" && !singleFilePackage && extension.sourceInfo.baseDir
				? extension.sourceInfo.baseDir
				: undefined;
		const slashIndex = resolvedPath.lastIndexOf("/");
		const directoryEntry = /\/index\.[cm]?[jt]s$/u.test(resolvedPath);
		const matched = packageRoot
			? stackContainsPath(normalizedStack, packageRoot, true)
			: directoryEntry && slashIndex !== -1
				? stackContainsPath(normalizedStack, resolvedPath.slice(0, slashIndex), true)
				: stackContainsPath(normalizedStack, resolvedPath, false);
		if (!matched) continue;

		const label =
			extension.sourceInfo.origin === "package" && extension.sourceInfo.source
				? extension.sourceInfo.source
				: extension.path;
		if (!seen.has(label)) {
			seen.add(label);
			matches.push(label);
		}
	}
	return matches;
}
