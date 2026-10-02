import { globSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export function findPackageDirectories(root = process.cwd()) {
	const { workspaces } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
	return [
		...new Set(
			globSync(
				workspaces.map((pattern) => `${pattern}/package.json`),
				{ cwd: root },
			),
		),
	]
		.map((manifest) => relative(process.cwd(), resolve(root, manifest, "..")))
		.sort();
}

export function getPublicWorkspacePackages() {
	return findPackageDirectories()
		.map((directory) => ({
			directory,
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}))
		.filter((pkg) => pkg.private !== true);
}
