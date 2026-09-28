import { existsSync } from "node:fs";
import type { PackageScope } from "./package-manager-types.ts";
import type { NpmSource } from "./package-source.ts";

type InstalledScope = Exclude<PackageScope, "temporary">;
type PackageManagerName = "npm" | "pnpm" | "bun" | string;

export interface NpmPackageOperationsOptions {
	getInstallRoot(scope: PackageScope, temporary: boolean): string;
	ensureProject(installRoot: string): void;
	getPackageManagerName(): PackageManagerName;
	runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void>;
}

export class NpmPackageOperations {
	private readonly options: NpmPackageOperationsOptions;

	constructor(options: NpmPackageOperationsOptions) {
		this.options = options;
	}

	async install(source: NpmSource, scope: PackageScope, temporary: boolean): Promise<void> {
		const installRoot = this.options.getInstallRoot(scope, temporary);
		this.options.ensureProject(installRoot);
		await this.options.runNpmCommand(this.getInstallArgs([source.spec], installRoot));
	}

	async installBatch(specs: string[], scope: InstalledScope): Promise<void> {
		const installRoot = this.options.getInstallRoot(scope, false);
		this.options.ensureProject(installRoot);
		await this.options.runNpmCommand(this.getInstallArgs(specs, installRoot));
	}

	async uninstall(source: NpmSource, scope: PackageScope): Promise<void> {
		const installRoot = this.options.getInstallRoot(scope, false);
		if (!existsSync(installRoot)) return;

		const packageManagerName = this.options.getPackageManagerName();
		if (packageManagerName === "bun") {
			await this.options.runNpmCommand(["uninstall", source.name, "--cwd", installRoot]);
			return;
		}

		const args = ["uninstall", source.name, "--prefix", installRoot];
		if (packageManagerName !== "pnpm") args.push("--legacy-peer-deps");
		await this.options.runNpmCommand(args);
	}

	getGitDependencyInstallArgs(): string[] {
		switch (this.options.getPackageManagerName()) {
			case "bun":
				return ["install", "--omit=dev", "--omit=peer"];
			case "pnpm":
				return [
					"install",
					"--prod",
					"--config.auto-install-peers=false",
					"--config.strict-peer-dependencies=false",
					"--config.strict-dep-builds=false",
				];
			case "npm":
				return ["install", "--omit=dev", "--legacy-peer-deps"];
			default:
				return ["install"];
		}
	}

	private getInstallArgs(specs: string[], installRoot: string): string[] {
		const packageManagerName = this.options.getPackageManagerName();
		if (packageManagerName === "bun") {
			return ["install", ...specs, "--cwd", installRoot, "--omit=peer"];
		}
		if (packageManagerName === "pnpm") {
			return [
				"install",
				...specs,
				"--prefix",
				installRoot,
				"--config.auto-install-peers=false",
				"--config.strict-peer-dependencies=false",
				"--config.strict-dep-builds=false",
			];
		}
		return ["install", ...specs, "--prefix", installRoot, "--legacy-peer-deps"];
	}
}
