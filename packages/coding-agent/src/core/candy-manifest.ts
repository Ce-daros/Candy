import { readFileSync } from "node:fs";
import { stripBom } from "../utils/text.ts";

export interface CandyManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readCandyManifest(packageJsonPath: string): CandyManifest | null {
	try {
		const pkg: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		if (!isObject(pkg) || !isObject(pkg.candy)) {
			return null;
		}

		const manifest: CandyManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = pkg.candy[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}
