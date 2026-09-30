import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type ConfigWriteScope, ResourceConfiguration } from "./resource-configuration.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface ResourceOperationsHost {
	readonly resourceLoader: ResourceLoader;
	readonly settingsManager: SettingsManager;
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	getAllTools(): Array<{ name: string }>;
	getActiveToolNames(): string[];
	setActiveToolsByName(names: string[]): void;
	reload(): Promise<void>;
}

export type InstructionSaveResult = { saved: true; reloaded: true } | { saved: true; reloaded: false; error: Error };

export class ResourceOperations {
	private readonly host: ResourceOperationsHost;
	private readonly context: { cwd: string; agentDir: string };

	constructor(host: ResourceOperationsHost, context: { cwd: string; agentDir: string }) {
		this.host = host;
		this.context = context;
	}

	getActiveTools(): string[] {
		return this.host.getActiveToolNames();
	}

	getTools(): Array<{ name: string }> {
		return this.host.getAllTools();
	}

	getInventory() {
		const loader = this.host.resourceLoader;
		const source = loader.getSystemPromptSource();
		const extensions = loader.getExtensions();
		return {
			extensions: structuredClone({
				extensions: extensions.extensions.map(({ path, resolvedPath, sourceInfo }) => ({
					path,
					resolvedPath,
					sourceInfo,
				})),
				errors: extensions.errors,
				warnings: extensions.warnings,
			}),
			skills: structuredClone(loader.getSkills()),
			prompts: structuredClone(loader.getPrompts()),
			themes: {
				themes: loader.getThemes().themes.map(({ name, sourcePath, sourceInfo }) => ({
					name,
					sourcePath,
					sourceInfo: structuredClone(sourceInfo),
				})),
				diagnostics: structuredClone(loader.getThemes().diagnostics),
			},
			instructions: structuredClone([
				...new Map(
					[
						...(source ? [source] : []),
						...loader.getAppendSystemPromptSources(),
						...loader.getAgentsFiles().agentsFiles,
					].map((file) => [resolve(file.path), file]),
				).values(),
			]),
		};
	}

	async getConfiguration(scope: ConfigWriteScope = "global") {
		const settings = this.host.settingsManager;
		const { cwd, agentDir } = this.context;
		const paths = await ResourceConfiguration.resolve(settings, cwd, agentDir);
		return { paths, operations: new ResourceConfiguration(settings, cwd, agentDir, paths.global, scope) };
	}

	private assertIdle(): void {
		if (this.host.isStreaming || this.host.isCompacting) {
			throw new Error("Wait for the current response or compaction to finish");
		}
	}

	private assertInstruction(path: string): void {
		const loader = this.host.resourceLoader;
		const source = loader.getSystemPromptSource();
		const files = [
			...(source ? [source] : []),
			...loader.getAppendSystemPromptSources(),
			...loader.getAgentsFiles().agentsFiles,
		];
		if (!files.some((file) => resolve(file.path) === resolve(path))) {
			throw new Error(`Instruction file is not part of the current resources: ${path}`);
		}
	}

	async readInstruction(path: string): Promise<string> {
		this.assertInstruction(path);
		return readFile(path, "utf8");
	}

	async saveInstruction(path: string, content: string): Promise<InstructionSaveResult> {
		this.assertIdle();
		this.assertInstruction(path);
		await writeFile(path, content, "utf8");
		try {
			await this.reload();
			return { saved: true, reloaded: true };
		} catch (error) {
			return { saved: true, reloaded: false, error: error instanceof Error ? error : new Error(String(error)) };
		}
	}

	setActiveTools(names: string[]): void {
		this.assertIdle();
		this.assertToolNames(names);
		this.host.setActiveToolsByName(names);
	}

	async saveDefaultTools(names?: string[]): Promise<void> {
		if (names !== undefined) this.assertToolNames(names);
		await this.host.settingsManager.commitSetting("global", "defaultTools", names);
	}

	private assertToolNames(names: string[]): void {
		const available = new Set(this.host.getAllTools().map((tool) => tool.name));
		const unknown = names.filter((name) => !available.has(name));
		if (unknown.length > 0) throw new Error(`Unknown tools: ${unknown.join(", ")}`);
	}

	async reload(): Promise<void> {
		this.assertIdle();
		await this.host.reload();
	}
}
