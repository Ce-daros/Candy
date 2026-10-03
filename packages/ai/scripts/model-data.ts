import { readFileSync } from "node:fs";
import { join } from "node:path";

const MODEL_DATA_IMPORT_PATTERN =
	/^import \{ [A-Z][A-Z0-9_]*_IMAGE_MODELS, [A-Z][A-Z0-9_]*_MODELS \} from "\.\/providers\/([^"/]+)\.models\.ts";$/gm;

export function assertExactModelIds(label: string, expected: Iterable<string>, actual: Iterable<string>): void {
	const expectedIds = new Set(expected);
	const actualIds = new Set(actual);
	const missing = [...expectedIds].filter((id) => !actualIds.has(id)).sort();
	const extra = [...actualIds].filter((id) => !expectedIds.has(id)).sort();
	if (missing.length === 0 && extra.length === 0) return;
	const difference = [missing.length ? `missing: ${missing.join(", ")}` : "", extra.length ? `extra: ${extra.join(", ")}` : ""]
		.filter(Boolean)
		.join("; ");
	throw new Error(`${label} model IDs do not match (${difference})`);
}

export function readModelDataProviderIds(packageRoot: string): string[] {
	const aggregatorPath = join(packageRoot, "src", "models.generated.ts");
	const aggregator = readFileSync(aggregatorPath, "utf8");
	const providerIds = Array.from(aggregator.matchAll(MODEL_DATA_IMPORT_PATTERN), (match) => match[1]).sort();
	if (providerIds.length === 0) throw new Error(`No generated provider imports found in ${aggregatorPath}`);
	return providerIds;
}
