import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "../src/core/http-dispatcher.ts";
import { InMemorySettingsStorage, type Settings, SettingsManager } from "../src/core/settings-manager.ts";

describe("SettingsManager", () => {
	const testDir = join(process.cwd(), "test-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		// Clean up and create fresh directories
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".candy"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("preserves externally added settings", () => {
		it("should preserve custom settings when changing theme", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					defaultModel: "claude-sonnet",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User adds custom settings externally
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.shellPath = "/bin/zsh";
			currentSettings.extensions = ["/path/to/extension.ts"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes theme
			await manager.setTheme("light");
			await manager.flush();

			// Verify all settings preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toBe("light");
		});

		it("should let in-memory changes override file changes for same key", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User externally sets thinking level to "low"
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.defaultThinkingLevel = "low";
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// But then changes it via UI to "high"
			await manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// In-memory change should win
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.defaultThinkingLevel).toBe("high");
		});
	});

	describe("package settings", () => {
		it("should keep local-only extensions in extensions array", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					extensions: ["/local/ext.ts", "./relative/ext.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getPackages()).toEqual([]);
			expect(manager.getExtensionPaths()).toEqual(["/local/ext.ts", "./relative/ext.ts"]);
		});

		it("should handle packages with filtering objects", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					packages: [
						"npm:simple-pkg",
						{
							source: "npm:shitty-extensions",
							extensions: ["extensions/oracle.ts"],
							skills: [],
						},
					],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const packages = manager.getPackages();
			expect(packages).toHaveLength(2);
			expect(packages[0]).toBe("npm:simple-pkg");
			expect(packages[1]).toEqual({
				source: "npm:shitty-extensions",
				extensions: ["extensions/oracle.ts"],
				skills: [],
			});
		});
	});

	describe("reload", () => {
		it("should reload global settings from disk", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					extensions: ["/before.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "light",
					extensions: ["/after.ts"],
					defaultModel: "claude-sonnet",
				}),
			);

			await manager.reload();

			expect(manager.getTheme()).toBe("light");
			expect(manager.getExtensionPaths()).toEqual(["/after.ts"]);
			expect(manager.getDefaultModel()).toBe("claude-sonnet");
		});

		it("should keep previous settings and report the file path when the file is invalid", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(settingsPath, "{ invalid json");
			await expect(manager.reload()).rejects.toThrow();

			expect(manager.getTheme()).toBe("dark");
			expect(manager.drainErrors()).toMatchObject([{ scope: "global", path: settingsPath }]);
		});
	});

	describe("theme setting", () => {
		it("stores slash-separated automatic theme settings separately from fixed theme names", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "light/dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTheme()).toBeUndefined();
			expect(manager.getThemeSetting()).toBe("light/dark");

			await manager.setTheme("solarized-light/tokyo-night");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.theme).toBe("solarized-light/tokyo-night");
		});
	});

	describe("error tracking", () => {
		it.each([null, [], "invalid", 42])("reports a non-object settings root %j", async (root) => {
			const settingsPath = join(agentDir, "settings.json");
			const content = JSON.stringify(root);
			writeFileSync(settingsPath, content);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.drainErrors()).toMatchObject([
				{
					scope: "global",
					path: settingsPath,
					error: { message: "Settings must be a JSON object" },
				},
			]);
			await expect(manager.setTheme("light")).rejects.toThrow("Settings must be a JSON object");
			expect(readFileSync(settingsPath, "utf-8")).toBe(content);
		});

		it("should collect and clear load errors via drainErrors", () => {
			const globalSettingsPath = join(agentDir, "settings.json");
			const projectSettingsPath = join(projectDir, ".candy", "settings.json");
			writeFileSync(globalSettingsPath, "{ invalid global json");
			writeFileSync(projectSettingsPath, "{ invalid project json");

			const manager = SettingsManager.create(projectDir, agentDir);
			const errors = manager.drainErrors();

			expect(errors).toHaveLength(2);
			expect(errors).toMatchObject([
				{ scope: "global", path: globalSettingsPath },
				{ scope: "project", path: projectSettingsPath },
			]);
			expect(manager.drainErrors()).toEqual([]);
		});
	});

	describe("project trust", () => {
		it("should skip project settings when project is not trusted", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "global" }));
			writeFileSync(join(projectDir, ".candy", "settings.json"), JSON.stringify({ theme: "project" }));

			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			expect(manager.isProjectTrusted()).toBe(false);
			expect(manager.getTheme()).toBe("global");
			expect(manager.getProjectSettings()).toEqual({});
		});

		it("should reload project settings after trust changes to true", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "global" }));
			writeFileSync(join(projectDir, ".candy", "settings.json"), JSON.stringify({ theme: "project" }));
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			manager.setProjectTrusted(true);

			expect(manager.isProjectTrusted()).toBe(true);
			expect(manager.getTheme()).toBe("project");
		});

		it("preserves runtime overrides and publishes project trust changes", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "global" }));
			writeFileSync(join(projectDir, ".candy", "settings.json"), JSON.stringify({ theme: "project" }));
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
			const events: Array<{ scope: string; fields: readonly string[] }> = [];
			manager.subscribe((event) => events.push(event));
			manager.setRuntimeOverride("theme", "runtime");
			events.length = 0;

			manager.setProjectTrusted(true);
			expect(manager.getThemeSetting()).toBe("runtime");
			expect(events).toEqual([{ scope: "project", fields: ["theme"] }]);

			manager.setProjectTrusted(false);
			expect(manager.getThemeSetting()).toBe("runtime");
			expect(events.at(-1)).toEqual({ scope: "project", fields: ["theme"] });
		});

		it("should reject project settings writes when project is not trusted", async () => {
			const projectSettingsPath = join(projectDir, ".candy", "settings.json");
			writeFileSync(projectSettingsPath, JSON.stringify({ packages: ["npm:existing"] }));
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			await expect(manager.setProjectPackages(["npm:new"])).rejects.toThrow(
				"Project is not trusted; refusing to write project settings",
			);

			expect(manager.getProjectSettings()).toEqual({});
			expect(JSON.parse(readFileSync(projectSettingsPath, "utf-8"))).toEqual({ packages: ["npm:existing"] });
		});

		it("should read default project trust from global settings only", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
			writeFileSync(join(projectDir, ".candy", "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.read("default-project-trust")).toBe("always");
		});

		it("should default invalid project trust settings to ask", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "sometimes" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.read("default-project-trust")).toBe("ask");
		});
	});

	describe("project settings directory creation", () => {
		it("should not create .candy folder when only reading project settings", () => {
			// Create agent dir with global settings, but NO .candy folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .candy folder that beforeEach created
			rmSync(join(projectDir, ".candy"), { recursive: true });

			// Create SettingsManager (reads both global and project settings)
			const manager = SettingsManager.create(projectDir, agentDir);

			// .candy folder should NOT have been created just from reading
			expect(existsSync(join(projectDir, ".candy"))).toBe(false);

			// Settings should still be loaded from global
			expect(manager.getTheme()).toBe("dark");
		});

		it("should create .candy folder when writing project settings", async () => {
			// Create agent dir with global settings, but NO .candy folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .candy folder that beforeEach created
			rmSync(join(projectDir, ".candy"), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);

			// .candy folder should NOT exist yet
			expect(existsSync(join(projectDir, ".candy"))).toBe(false);

			// Write a project-specific setting
			manager.setProjectPackages([{ source: "npm:test-pkg" }]);
			await manager.flush();

			// Now .candy folder should exist
			expect(existsSync(join(projectDir, ".candy"))).toBe(true);

			// And settings file should be created
			expect(existsSync(join(projectDir, ".candy", "settings.json"))).toBe(true);
		});
	});

	describe("terminal capability overrides", () => {
		it("maps explicit values and omits auto values", () => {
			const getOverrides = (terminal: NonNullable<Settings["terminal"]>) =>
				SettingsManager.inMemory({ terminal }).getTerminalCapabilityOverrides();

			expect(getOverrides({ images: false, trueColor: false, hyperlinks: false })).toEqual({
				images: null,
				trueColor: false,
				hyperlinks: false,
			});
			expect(getOverrides({ images: "kitty", trueColor: true, hyperlinks: true })).toEqual({
				images: "kitty",
				trueColor: true,
				hyperlinks: true,
			});
			expect(getOverrides({ images: "auto", trueColor: "auto", hyperlinks: "auto" })).toEqual({});
			expect(getOverrides({ images: "sixel" })).toEqual({ images: "sixel" });
		});

		it("loads an explicit project Sixel protocol without terminal environment markers", () => {
			writeFileSync(join(projectDir, ".candy", "settings.json"), JSON.stringify({ terminal: { images: "sixel" } }));
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
			expect(manager.getTerminalCapabilityOverrides()).toEqual({ images: "sixel" });
		});
	});

	describe("retry settings", () => {
		it("defaults and overrides agent retry delay cap", () => {
			expect(SettingsManager.inMemory().getRetrySettings()).toEqual({
				enabled: true,
				maxRetries: 3,
				baseDelayMs: 2000,
				maxAgentDelayMs: 60000,
			});
			expect(
				SettingsManager.inMemory({
					retry: { enabled: true, maxRetries: 10, baseDelayMs: 500, maxAgentDelayMs: 5000 },
				}).getRetrySettings(),
			).toEqual({ enabled: true, maxRetries: 10, baseDelayMs: 500, maxAgentDelayMs: 5000 });
		});
	});

	describe("httpIdleTimeoutMs", () => {
		it("should default to 5 minutes", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.read("http-idle-timeout")).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
		});

		it("should use merged global and project settings", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 300000 }));
			writeFileSync(join(projectDir, ".candy", "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 0 }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.read("http-idle-timeout")).toBe(0);
		});

		it("should reject invalid timeout values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: -1 }));
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(() => manager.read("http-idle-timeout")).toThrow("Invalid httpIdleTimeoutMs setting");
		});
	});

	describe("cacheWarming", () => {
		it("defaults to streaming and ignores project settings", () => {
			expect(SettingsManager.create(projectDir, agentDir).read("cache-warming-mode")).toBe("streaming");

			writeFileSync(join(projectDir, ".candy", "settings.json"), JSON.stringify({ cacheWarming: "idle" }));
			expect(SettingsManager.create(projectDir, agentDir).read("cache-warming-mode")).toBe("streaming");

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "idle" }));
			expect(SettingsManager.create(projectDir, agentDir).read("cache-warming-mode")).toBe("idle");

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "bogus" }));
			expect(SettingsManager.create(projectDir, agentDir).read("cache-warming-mode")).toBe("streaming");
		});

		it("persists the mode globally", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			await manager.commitSetting("global", "cacheWarming", "off");
			await manager.flush();

			expect(SettingsManager.create(projectDir, agentDir).read("cache-warming-mode")).toBe("off");
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({ cacheWarming: "off" });
		});
	});

	describe("externalEditor", () => {
		const originalVisual = process.env.VISUAL;
		const originalEditor = process.env.EDITOR;
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

		function setEditorEnv(visual?: string, editor?: string): void {
			if (visual === undefined) delete process.env.VISUAL;
			else process.env.VISUAL = visual;
			if (editor === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = editor;
		}

		afterEach(() => {
			setEditorEnv(originalVisual, originalEditor);
			if (originalPlatform) {
				Object.defineProperty(process, "platform", originalPlatform);
			}
		});

		it("should resolve editor commands by precedence", () => {
			setEditorEnv("vim", "nano");
			expect(SettingsManager.inMemory({ externalEditor: "code --wait" }).getExternalEditorCommand()).toBe(
				"code --wait",
			);
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("vim");

			setEditorEnv(undefined, "emacs");
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("emacs");
		});

		it("should fall back to platform defaults", () => {
			setEditorEnv();
			Object.defineProperty(process, "platform", { value: "win32" });
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("notepad");

			Object.defineProperty(process, "platform", { value: "darwin" });
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("nano");

			Object.defineProperty(process, "platform", { value: "linux" });
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("nano");
		});
	});

	it("validates and persists fullscreen settings", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.read("fullscreen-exit-output")).toBe("transcript");
		expect(manager.read("fullscreen-scrollbar")).toBe("auto");
		expect(manager.read("fullscreen-copy-on-select")).toBe(true);

		manager.commitSetting("global", "fullscreenExitOutput", "resume-hint");
		await manager.commitSetting("global", "fullscreenScrollbar", "hidden");
		manager.commitSetting("global", "fullscreenCopyOnSelect", false);
		await manager.flush();
		const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(savedSettings.fullscreenExitOutput).toBe("resume-hint");
		expect(savedSettings.fullscreenScrollbar).toBe("hidden");
		expect(savedSettings.fullscreenCopyOnSelect).toBe(false);

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ fullscreenExitOutput: "nothing", fullscreenScrollbar: "sometimes" }),
		);
		const reloadedManager = SettingsManager.create(projectDir, agentDir);
		expect(reloadedManager.read("fullscreen-exit-output")).toBe("transcript");
		expect(reloadedManager.read("fullscreen-scrollbar")).toBe("auto");
		expect(reloadedManager.read("fullscreen-copy-on-select")).toBe(true);
	});

	describe("outputPad", () => {
		it("should default to 1 and persist binary values", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.read("output-padding")).toBe(1);

			manager.commitSetting("global", "outputPad", 0);
			await manager.flush();

			expect(manager.read("output-padding")).toBe(0);
			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.outputPad).toBe(0);
		});

		it("should treat unsupported outputPad values as default padding", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ outputPad: 2 }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.read("output-padding")).toBe(1);
		});
	});

	describe("markdown.mermaid", () => {
		it("defaults to final rendering and persists rendering modes", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.read("mermaid-rendering")).toBe("final");

			manager.commitNestedSetting("global", "markdown", "mermaid", "streaming");
			await manager.flush();

			expect(manager.read("mermaid-rendering")).toBe("streaming");
			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.markdown.mermaid).toBe("streaming");
		});

		it("uses final rendering for unsupported values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ markdown: { mermaid: "sometimes" } }));

			expect(SettingsManager.create(projectDir, agentDir).read("mermaid-rendering")).toBe("final");
		});
	});

	describe("redesign defaults", () => {
		it("collapses thinking and changelog by default while preserving saved choices", () => {
			expect(SettingsManager.inMemory().read("hide-thinking")).toBe(true);
			expect(SettingsManager.inMemory().read("collapse-changelog")).toBe(true);
			expect(
				SettingsManager.inMemory({ hideThinkingBlock: false, collapseChangelog: false }).read("hide-thinking"),
			).toBe(false);
			expect(
				SettingsManager.inMemory({ hideThinkingBlock: false, collapseChangelog: false }).read("collapse-changelog"),
			).toBe(false);
		});

		it("defaults tool previews to five rows and persists the selected limit", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.read("tool-preview-lines")).toBe(5);

			await manager.commitSetting("global", "toolPreviewLines", 20);
			await manager.flush();

			expect(SettingsManager.create(projectDir, agentDir).read("tool-preview-lines")).toBe(20);
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).toolPreviewLines).toBe(20);
		});
	});

	describe("shellCommandPrefix", () => {
		it("should load shellCommandPrefix from settings", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBe("shopt -s expand_aliases");
		});

		it("should return undefined when shellCommandPrefix is not set", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBeUndefined();
		});

		it("should preserve shellCommandPrefix when saving unrelated settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			await manager.setTheme("light");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellCommandPrefix).toBe("shopt -s expand_aliases");
			expect(savedSettings.theme).toBe("light");
		});
	});

	describe("defaultTools", () => {
		it("loads global defaults and lets project settings replace them", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "bash"] }));

			expect(SettingsManager.create(projectDir, agentDir).getDefaultTools()).toEqual(["read", "bash"]);

			writeFileSync(join(projectDir, ".candy", "settings.json"), JSON.stringify({ defaultTools: ["grep"] }));

			expect(SettingsManager.create(projectDir, agentDir).getDefaultTools()).toEqual(["grep"]);
		});

		it("preserves an empty tool list", () => {
			expect(SettingsManager.inMemory({ defaultTools: [] }).getDefaultTools()).toEqual([]);
			expect(SettingsManager.inMemory().getDefaultTools()).toBeUndefined();
		});
	});

	describe("getSessionDir", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBeUndefined();
		});

		it("should return global sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/tmp/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("/tmp/sessions");
		});

		it("should return project sessionDir, overriding global", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/global/sessions" }));
			writeFileSync(join(projectDir, ".candy", "settings.json"), JSON.stringify({ sessionDir: "./sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("./sessions");
		});

		it("should expand ~ in sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "~/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe(join(homedir(), "sessions"));
		});
	});

	describe("getShellPath", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBeUndefined();
		});

		it("should return an absolute shellPath unchanged", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: "/bin/zsh" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBe("/bin/zsh");
		});

		it("should expand ~ in shellPath", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ shellPath: "~/.local/bin/agent-shell-sandbox" }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBe(join(homedir(), ".local/bin/agent-shell-sandbox"));
		});

		it("should expand a bare ~ in shellPath", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: "~" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBe(homedir());
		});
	});

	describe("settings commits", () => {
		it("publishes only after persistence and preserves runtime overrides", async () => {
			let failWrite = false;
			let global = JSON.stringify({ theme: "saved" });
			const manager = SettingsManager.fromStorage({
				withLock(scope, update) {
					const current = scope === "global" ? global : undefined;
					const next = update(current);
					if (next === undefined) return;
					if (failWrite) throw new Error("disk unavailable");
					if (scope === "global") global = next;
				},
			});
			const events: Array<{ scope: string; fields: readonly string[] }> = [];
			manager.subscribe((event) => events.push(event));
			manager.setRuntimeOverride("theme", "runtime");
			events.length = 0;

			failWrite = true;
			await expect(manager.commitSetting("global", "defaultModel", "model-a")).rejects.toThrow("disk unavailable");
			expect(manager.getDefaultModel()).toBeUndefined();
			expect(events).toEqual([]);

			failWrite = false;
			await manager.commitDefaultModelAndProvider("provider-a", "model-a");
			expect(manager.getGlobalSettings()).toMatchObject({ defaultProvider: "provider-a", defaultModel: "model-a" });
			expect(manager.getThemeSetting()).toBe("runtime");
			expect(events).toEqual([{ scope: "global", fields: ["defaultProvider", "defaultModel"] }]);

			manager.clearRuntimeOverride("theme");
			expect(manager.getThemeSetting()).toBe("saved");
		});

		it("merges a nested commit into the latest locked settings", async () => {
			const path = join(agentDir, "settings.json");
			writeFileSync(path, JSON.stringify({ terminal: { showImages: true } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			writeFileSync(path, JSON.stringify({ terminal: { showImages: true, trueColor: false } }));

			await manager.commitTerminalSetting("showImages", false);

			expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
				terminal: { showImages: false, trueColor: false },
			});
		});

		it("publishes runtime override batches and changed settings after reload", async () => {
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify({ theme: "saved", transport: "sse" }));
			const manager = SettingsManager.fromStorage(storage);
			const events: Array<{ scope: string; fields: readonly string[] }> = [];
			manager.subscribe((event) => events.push(event));

			manager.applyOverrides({ theme: "runtime", transport: "websocket" });
			expect(events).toEqual([{ scope: "runtime", fields: ["theme", "transport"] }]);
			events.length = 0;

			storage.withLock("global", () => JSON.stringify({ theme: "changed", retry: { enabled: false } }));
			await manager.reload();

			expect(events).toEqual([{ scope: "global", fields: ["theme", "transport", "retry"] }]);
			expect(manager.getThemeSetting()).toBe("runtime");
			expect(manager.getRetryEnabled()).toBe(false);
		});

		it("rejects malformed reloads and retains the last valid settings", async () => {
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify({ theme: "saved" }));
			const manager = SettingsManager.fromStorage(storage);
			storage.withLock("global", () => "{ invalid json");

			await expect(manager.reload()).rejects.toThrow();
			expect(manager.getThemeSetting()).toBe("saved");
		});
	});
});
