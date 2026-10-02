import { homedir } from "node:os";
import * as path from "node:path";
import type { AutocompleteProvider } from "@candy/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { Container } from "../../tui/src/tui.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import { TransientNotification } from "../src/modes/interactive/components/transient-notification.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

function normalizeRenderedOutput(container: Container, width = 220): string {
	return renderAll(container, width)
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\\/g, "/")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

function normalizeResourceDetails(fakeThis: any): string {
	fakeThis.options.verbose = true;
	(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, { force: false });
	return normalizeRenderedOutput(fakeThis.loadedResourcesContainer);
}

type ExtensionFixture = {
	path: string;
	sourceInfo?: SourceInfo;
};

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("replaces immediately-sequential transient status messages", () => {
		const notification = new TransientNotification(vi.fn(), () => false);
		const fakeThis: any = {
			chatContainer: new Container(),
			notification,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(notification.render(120).join("\n")).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		expect(notification.render(120).join("\n")).toContain("STATUS_TWO");
		expect(notification.render(120).join("\n")).not.toContain("STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(0);
		notification.dispose();
	});

	test("keeps a transient status outside the transcript when chat changes", () => {
		const notification = new TransientNotification(vi.fn(), () => false);
		const fakeThis: any = {
			chatContainer: new Container(),
			notification,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		expect(fakeThis.chatContainer.children).toHaveLength(1);
		expect(renderLastLine(fakeThis.chatContainer)).toBe("OTHER");
		expect(notification.render(120).join("\n")).toContain("STATUS_TWO");
		notification.dispose();
	});
});

describe("InteractiveMode.showManagedToolStatus", () => {
	beforeAll(() => initTheme("dark"));

	test("renders tool updates as one contiguous group", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			renderer: { requestRender: vi.fn() },
			managedToolStatusStarted: false,
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};
		const showManagedToolStatus = (InteractiveMode as any).prototype.showManagedToolStatus;

		showManagedToolStatus.call(fakeThis, { type: "info", message: "fd downloading" });
		showManagedToolStatus.call(fakeThis, { type: "info", message: "rg downloading" });
		showManagedToolStatus.call(fakeThis, { type: "warning", message: "rg failed" });

		expect(fakeThis.chatContainer.children).toHaveLength(4);
		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toBe(
			"fd downloading\n rg downloading\n Warning: rg failed",
		);
	});
});

describe("InteractiveMode.setToolsExpanded", () => {
	test("applies expansion state to the active header and chat entries", () => {
		const header = { setExpanded: vi.fn() };
		const loadedResourcesChild = { setExpanded: vi.fn() };
		const chatChild = { setExpanded: vi.fn() };
		const fakeThis: any = {
			toolOutputExpanded: false,
			customHeader: undefined,
			builtInHeader: header,
			loadedResourcesContainer: { children: [loadedResourcesChild] },
			chatContainer: { children: [chatChild] },
			renderer: { requestRender: vi.fn() },
			showStatus: vi.fn(),
		};

		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);

		expect(fakeThis.toolOutputExpanded).toBe(true);
		expect(header.setExpanded).toHaveBeenCalledWith(true);
		expect(loadedResourcesChild.setExpanded).not.toHaveBeenCalled();
		expect(chatChild.setExpanded).toHaveBeenCalledWith(true);
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Details expanded");
	});
});

describe("InteractiveMode.createBaseAutocompleteProvider", () => {
	test("keeps ordinary slash text out of command discovery", async () => {
		const createBaseAutocompleteProvider = (
			InteractiveMode as unknown as {
				prototype: {
					createBaseAutocompleteProvider(this: {
						sessionManager: { getCwd: () => string };
						fdPath: null;
					}): AutocompleteProvider;
				};
			}
		).prototype.createBaseAutocompleteProvider;
		const provider = createBaseAutocompleteProvider.call({
			sessionManager: { getCwd: () => process.cwd() },
			fdPath: null,
		});
		const line = "/model";
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});
		expect(suggestions).toBeNull();
	});
});
describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: boolean;
		verbose?: boolean;
		toolOutputExpanded?: boolean;
		cwd?: string;
		contextFiles?: Array<{ path: string; content?: string }>;
		systemPromptSource?: { path: string };
		appendSystemPromptSources?: Array<{ path: string }>;
		extensions?: ExtensionFixture[];
		skills?: Array<{ filePath: string; name: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
		useRealScopeGroups?: boolean;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			toolOutputExpanded: options.toolOutputExpanded ?? false,
			loadedResourcesContainer: new Container(),
			chatContainer: new Container(),
			settingsManager: SettingsManager.inMemory({ quietStartup: options.quietStartup }),
			splashComponent: { setResources: vi.fn() },
			getHomeResources: vi.fn(() => ({ context: 1, skills: 1, prompts: 1, extensions: 1 })),
			sessionManager: {
				getCwd: () => options.cwd ?? "/tmp/project",
			},
			session: {
				execution: {
					promptTemplates: [],
					extensionRunner: {
						getCommandDiagnostics: () => [],
						getShortcutDiagnostics: () => [],
					},
					resourceLoader: {
						getPathMetadata: () => new Map(),
						getAgentsFiles: () => ({ agentsFiles: options.contextFiles ?? [] }),
						getSystemPromptSource: () => options.systemPromptSource,
						getAppendSystemPromptSources: () => options.appendSystemPromptSources ?? [],
						getSkills: () => ({
							skills: options.skills ?? [],
							diagnostics: options.skillDiagnostics ?? [],
						}),
						getPrompts: () => ({ prompts: [], diagnostics: [] }),
						getExtensions: () => ({ extensions: options.extensions ?? [], errors: [], runtime: {} }),
						getThemes: () => ({ themes: [], diagnostics: [] }),
					},
				},
			},
			formatDisplayPath: (p: string) => (InteractiveMode as any).prototype.formatDisplayPath.call(fakeThis, p),
			formatExtensionDisplayPath: (p: string) =>
				(InteractiveMode as any).prototype.formatExtensionDisplayPath.call(fakeThis, p),
			formatContextPath: (p: string) => (InteractiveMode as any).prototype.formatContextPath.call(fakeThis, p),
			getStartupExpansionState: () => (InteractiveMode as any).prototype.getStartupExpansionState.call(fakeThis),
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			isPackageSource: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.isPackageSource.call(fakeThis, sourceInfo),
			getShortPath: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getShortPath.call(fakeThis, p, sourceInfo),
			getCompactPathLabel: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPathLabel.call(fakeThis, p, sourceInfo),
			getCompactPackageSourceLabel: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPackageSourceLabel.call(fakeThis, sourceInfo),
			getCompactExtensionLabel: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabel.call(fakeThis, p, sourceInfo),
			getCompactDisplayPathSegments: (p: string) =>
				(InteractiveMode as any).prototype.getCompactDisplayPathSegments.call(fakeThis, p),
			getCompactNonPackageExtensionLabel: (
				p: string,
				index: number,
				allPaths: Array<{ path: string; segments: string[] }>,
			) => (InteractiveMode as any).prototype.getCompactNonPackageExtensionLabel.call(fakeThis, p, index, allPaths),
			getCompactExtensionLabels: (extensions: ExtensionFixture[]) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabels.call(fakeThis, extensions),
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
		};

		if (options.useRealScopeGroups) {
			fakeThis.getScopeGroup = (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getScopeGroup.call(fakeThis, sourceInfo);
			fakeThis.buildScopeGroups = (items: Array<{ path: string; sourceInfo?: SourceInfo }>) =>
				(InteractiveMode as any).prototype.buildScopeGroups.call(fakeThis, items);
			fakeThis.formatScopeGroups = (groups: unknown, formatOptions: unknown) =>
				(InteractiveMode as any).prototype.formatScopeGroups.call(fakeThis, groups, formatOptions);
		}

		return fakeThis;
	}

	function createSourceInfo(
		filePath: string,
		options: {
			source: string;
			scope: "user" | "project" | "temporary";
			origin: "package" | "top-level";
			baseDir?: string;
		},
	): SourceInfo {
		return {
			path: filePath,
			source: options.source,
			scope: options.scope,
			origin: options.origin,
			baseDir: options.baseDir,
		};
	}

	function createExtensionFixtures(): ExtensionFixture[] {
		return [
			{
				path: "/tmp/project/.candy/extensions/answer.ts",
				sourceInfo: createSourceInfo("/tmp/project/.candy/extensions/answer.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.candy/extensions",
				}),
			},
			{
				path: "/tmp/project/.candy/extensions/local-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.candy/extensions/local-index/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.candy/extensions",
				}),
			},
			{
				path: "/tmp/agent/extensions/user-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/agent/extensions/user-index/index.ts", {
					source: "local",
					scope: "user",
					origin: "top-level",
					baseDir: "/tmp/agent/extensions",
				}),
			},
			{
				path: "/tmp/project/.candy/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.candy/npm/node_modules/pi-markdown-preview/extensions/index.ts",
					{
						source: "npm:pi-markdown-preview",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.candy/npm/node_modules/pi-markdown-preview",
					},
				),
			},
			{
				path: "/tmp/project/.candy/npm/node_modules/@scope/pi-scoped/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.candy/npm/node_modules/@scope/pi-scoped/extensions/index.ts", {
					source: "npm:@scope/pi-scoped",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.candy/npm/node_modules/@scope/pi-scoped",
				}),
			},
			{
				path: "/tmp/project/.candy/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.candy/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.candy/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/project/.candy/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.candy/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.candy/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/temp/cli-extension.ts",
				sourceInfo: createSourceInfo("/tmp/temp/cli-extension.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/temp",
				}),
			},
		];
	}

	test("does not show a resource listing by default", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).not.toContain("Loaded resources");
		expect(output).not.toContain("commit");
		expect(output).not.toContain("/tmp/skill/SKILL.md");
	});

	test("refreshes splash resource counts during quiet resource updates", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, { force: false });

		expect(fakeThis.getHomeResources).toHaveBeenCalledOnce();
		expect(fakeThis.splashComponent.setResources).toHaveBeenCalledWith({
			context: 1,
			skills: 1,
			prompts: 1,
			extensions: 1,
		});
		expect(fakeThis.loadedResourcesContainer.children).toHaveLength(0);
	});

	test("shows full resource listing in verbose mode", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			verbose: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).not.toContain("Loaded resources");
		expect(output).toContain("Skills  1");
		expect(output).toContain("commit");
		expect(output).toContain("/tmp/skill/SKILL.md");
	});

	test("shows full resource listing on verbose startup even when tool output is collapsed", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			verbose: true,
			toolOutputExpanded: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).not.toContain("Loaded resources");
		expect(output).toContain("commit");
		expect(output).toContain("/tmp/skill/SKILL.md");
	});

	test("shows extension details only in verbose output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			extensions: [{ path: "/tmp/extensions/answer.ts" }, { path: "/tmp/extensions/btw.ts" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).not.toContain("Loaded resources");
		expect(output).not.toContain("answer.ts");
		const details = normalizeResourceDetails(fakeThis);
		expect(details).toContain("answer.ts");
		expect(details).toContain("btw.ts");
	});

	test("adds more parent folders until local extension labels are unique", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
			{
				path: "/tmp/gamma/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/gamma/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/gamma",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = normalizeResourceDetails(fakeThis);
		expect(output).toMatch(/^\s*alpha\/one(?:\s|$)/m);
		expect(output).toContain("/tmp/alpha/one/index.ts");
		expect(output).toMatch(/^\s*beta\/one(?:\s|$)/m);
		expect(output).toContain("/tmp/beta/one/index.ts");
		expect(output).toMatch(/^\s*gamma\/one(?:\s|$)/m);
		expect(output).toContain("/tmp/gamma/one/index.ts");
	});

	test("strips index.ts from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = normalizeResourceDetails(fakeThis);
		expect(output).toMatch(/^\s*plan-mode(?:\s|$)/m);
		expect(output).toContain("/tmp/extensions/plan-mode/index.ts");
	});

	test("strips index.js from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.js",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.js", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = normalizeResourceDetails(fakeThis);
		expect(output).toMatch(/^\s*plan-mode(?:\s|$)/m);
		expect(output).toContain("/tmp/extensions/plan-mode/index.js");
	});

	test("mixed single-file and subdirectory index.ts extensions strip index.ts", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/webfetch.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/webfetch.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = normalizeResourceDetails(fakeThis);
		expect(output).toMatch(/^\s*webfetch\.ts(?:\s|$)/m);
		expect(output).toContain("/tmp/extensions/webfetch.ts");
		expect(output).toMatch(/^\s*plan-mode(?:\s|$)/m);
		expect(output).toContain("/tmp/extensions/plan-mode/index.ts");
	});

	test("multiple index.ts with unique parent dirs need no disambiguation", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/foo/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/foo/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/bar/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/bar/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = normalizeResourceDetails(fakeThis);
		expect(output).toMatch(/^\s*foo(?:\s|$)/m);
		expect(output).toContain("/tmp/extensions/foo/index.ts");
		expect(output).toMatch(/^\s*bar(?:\s|$)/m);
		expect(output).toContain("/tmp/extensions/bar/index.ts");
	});

	test("non-index file in subdirectory stays as filename", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/my-ext/main.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/my-ext/main.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = normalizeResourceDetails(fakeThis);
		expect(output).toMatch(/^\s*main\.ts(?:\s|$)/m);
		expect(output).toContain("/tmp/extensions/my-ext/main.ts");
	});

	test("package extensions still strip index.ts correctly (regression guard)", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/project/.candy/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.candy/npm/node_modules/pi-markdown-preview/extensions/index.ts",
					{
						source: "npm:pi-markdown-preview",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.candy/npm/node_modules/pi-markdown-preview",
					},
				),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = normalizeResourceDetails(fakeThis);
		expect(output).toMatch(/^\s*pi-markdown-preview(?:\s|$)/m);
		expect(output).toContain("/tmp/project/.candy/npm/node_modules/pi-markdown-preview/extensions/index.ts");
	});

	test("labels npm sibling extensions relative to the declaring package", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/project/.candy/npm/node_modules/primary-package/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.candy/npm/node_modules/primary-package/index.ts", {
					source: "npm:primary-package",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.candy/npm/node_modules/primary-package",
				}),
			},
			{
				path: "/tmp/project/.candy/npm/node_modules/sibling-package/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.candy/npm/node_modules/sibling-package/index.ts", {
					source: "npm:primary-package",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.candy/npm/node_modules/primary-package",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = normalizeResourceDetails(fakeThis);
		expect(output).toMatch(/^\s*primary-package(?:\s|$)/m);
		expect(output).toContain("/tmp/project/.candy/npm/node_modules/primary-package/index.ts");
		expect(output).toMatch(/^\s*primary-package:\.\.\/sibling-package(?:\s|$)/m);
		expect(output).toContain("/tmp/project/.candy/npm/node_modules/sibling-package/index.ts");
	});

	test("labels Windows npm sibling extensions relative to the declaring package", () => {
		const primaryPath = "C:\\Users\\me\\.candy\\agent\\npm\\node_modules\\primary-package\\index.ts";
		const siblingPath = "C:\\Users\\me\\.candy\\agent\\npm\\node_modules\\sibling-package\\index.ts";
		const baseDir = "C:\\Users\\me\\.candy\\agent\\npm\\node_modules\\primary-package";
		const extensions: ExtensionFixture[] = [
			{
				path: primaryPath,
				sourceInfo: createSourceInfo(primaryPath, {
					source: "npm:primary-package",
					scope: "user",
					origin: "package",
					baseDir,
				}),
			},
			{
				path: siblingPath,
				sourceInfo: createSourceInfo(siblingPath, {
					source: "npm:primary-package",
					scope: "user",
					origin: "package",
					baseDir,
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = normalizeResourceDetails(fakeThis);
		expect(output).toMatch(/^\s*primary-package(?:\s|$)/m);
		expect(output).toContain("C:/Users/me/.candy/agent/npm/node_modules/primary-package/index.ts");
		expect(output).toMatch(/^\s*primary-package:\.\.\/sibling-package(?:\s|$)/m);
		expect(output).toContain("C:/Users/me/.candy/agent/npm/node_modules/sibling-package/index.ts");
	});

	test("captures mixed extension layouts in verbose output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			verbose: true,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = normalizeResourceDetails(fakeThis);
		expect(output).toMatch(/^\s*answer\.ts(?:\s|$)/m);
		expect(output).toContain("/tmp/project/.candy/extensions/answer.ts");
		expect(output).toMatch(/^\s*local-index(?:\s|$)/m);
		expect(output).toContain("/tmp/project/.candy/extensions/local-index/index.ts");
		expect(output).toMatch(/^\s*user-index(?:\s|$)/m);
		expect(output).toContain("/tmp/agent/extensions/user-index/index.ts");
		expect(output).toMatch(/^\s*pi-markdown-preview(?:\s|$)/m);
		expect(output).toContain("/tmp/project/.candy/npm/node_modules/pi-markdown-preview/extensions/index.ts");
		expect(output).toMatch(/^\s*@scope\/pi-scoped(?:\s|$)/m);
		expect(output).toContain("/tmp/project/.candy/npm/node_modules/@scope/pi-scoped/extensions/index.ts");
		expect(output).toMatch(/^\s*HazAT\/pi-interactive-subagents(?:\s|$)/m);
		expect(output).toContain("/tmp/project/.candy/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts");
		expect(output).toMatch(/^\s*HazAT\/pi-interactive-subagents:subagents(?:\s|$)/m);
		expect(output).toContain(
			"/tmp/project/.candy/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
		);
		expect(output).toMatch(/^\s*cli-extension\.ts(?:\s|$)/m);
		expect(output).toContain("/tmp/temp/cli-extension.ts");
	});

	test("shows context paths relative to cwd while preserving full external paths", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			cwd,
			contextFiles: [
				{ path: path.join(home, ".candy", "agent", "AGENTS.md") },
				{ path: path.join(cwd, "AGENTS.md") },
			],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const collapsed = renderAll(fakeThis.loadedResourcesContainer).replace(/\\/g, "/");
		expect(collapsed).not.toContain("Loaded resources");
		expect(collapsed).not.toContain("AGENTS.md");
		const details = normalizeResourceDetails(fakeThis);
		expect(details).toContain("~/.candy/agent/AGENTS.md");
		expect(details).toContain("AGENTS.md");
		expect(details).toContain(`${cwd.replace(/\\/g, "/")}/AGENTS.md`);
	});

	test("shows system prompt context paths before project context files", () => {
		const cwd = "/tmp/project";
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			cwd,
			systemPromptSource: { path: path.join(cwd, ".candy", "SYSTEM.md") },
			appendSystemPromptSources: [{ path: path.join(cwd, ".candy", "APPEND_SYSTEM.md") }],
			contextFiles: [{ path: path.join(cwd, "AGENTS.md") }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = normalizeResourceDetails(fakeThis);
		expect(output).toContain("Context  3");
		expect(output.indexOf(".candy/SYSTEM.md")).toBeLessThan(output.indexOf(".candy/APPEND_SYSTEM.md"));
		expect(output.indexOf(".candy/APPEND_SYSTEM.md")).toBeLessThan(output.indexOf("AGENTS.md"));
	});

	test("shows full context paths in verbose output", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			verbose: true,
			cwd,
			contextFiles: [
				{ path: path.join(home, ".candy", "agent", "AGENTS.md") },
				{ path: path.join(cwd, "AGENTS.md") },
			],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer).replace(/\\/g, "/");
		expect(output).toContain("Context  2");
		expect(output).toContain("~/.candy/agent/AGENTS.md");
		expect(output).toContain(`${cwd.replace(/\\/g, "/")}/AGENTS.md`);
	});

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.loadedResourcesContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("Skill conflicts");
		expect(output).not.toContain("[Skills]");
	});
});
