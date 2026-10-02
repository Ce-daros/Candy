import { readdirSync } from "node:fs";
import { join } from "node:path";

export function* walkFiles(directory, ignoredDirectories = new Set()) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) yield* walkFiles(path, ignoredDirectories);
		} else if (entry.isFile()) yield path;
	}
}
