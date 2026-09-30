import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

/** Settings commits preserve external changes to fields outside the current patch. */
describe("SettingsManager - External Edit Preservation", () => {
	const testDir = join(process.cwd(), "test-settings-bug-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
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

	it("reports a failed save and accepts a later successful save", async () => {
		const settingsPath = join(agentDir, "settings.json");
		const manager = SettingsManager.create(projectDir, agentDir);
		writeFileSync(settingsPath, "{broken");

		await expect(manager.setShowImages(false)).rejects.toThrow();
		expect(readFileSync(settingsPath, "utf8")).toBe("{broken");
		expect(manager.getShowImages()).toBe(true);

		writeFileSync(settingsPath, "{}");
		await manager.setShowImages(false);
		expect(JSON.parse(readFileSync(settingsPath, "utf8")).terminal.showImages).toBe(false);
	});

	it("does not hide an earlier queued write failure behind a later success", async () => {
		let failNextWrite = false;
		let global = "{}";
		let project: string | undefined;
		const manager = SettingsManager.fromStorage({
			withLock(scope, update) {
				const current = scope === "global" ? global : project;
				const next = update(current);
				if (next === undefined) return;
				if (failNextWrite) {
					failNextWrite = false;
					throw new Error("first write failed");
				}
				if (scope === "global") global = next;
				else project = next;
			},
		});

		failNextWrite = true;
		const failedCommit = manager.setTheme("dark");
		const successfulCommit = manager.setShowImages(false);
		await expect(failedCommit).rejects.toThrow("first write failed");
		await successfulCommit;
		expect(JSON.parse(global)).toEqual({ terminal: { showImages: false } });
	});

	it("keeps effective settings unchanged when a commit cannot be saved", async () => {
		let failWrite = false;
		const storage = {
			withLock(_scope: "global" | "project", update: (current: string | undefined) => string | undefined) {
				if (failWrite) throw new Error("disk unavailable");
				return update(undefined);
			},
		};
		const manager = SettingsManager.fromStorage(storage);
		failWrite = true;

		await expect(manager.setTheme("dark")).rejects.toThrow("disk unavailable");
		expect(manager.getTheme()).toBeUndefined();
	});

	it("should preserve file changes to packages array when changing unrelated setting", async () => {
		const settingsPath = join(agentDir, "settings.json");

		// Initial state: packages has one item
		writeFileSync(
			settingsPath,
			JSON.stringify({
				theme: "dark",
				packages: ["npm:pi-mcp-adapter"],
			}),
		);

		// candy starts up, loads settings into memory
		const manager = SettingsManager.create(projectDir, agentDir);

		// At this point, globalSettings.packages = ["npm:pi-mcp-adapter"]
		expect(manager.getPackages()).toEqual(["npm:pi-mcp-adapter"]);

		// User externally edits settings.json to remove the package
		const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		currentSettings.packages = []; // User wants to remove this!
		writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

		// Verify file was changed
		expect(JSON.parse(readFileSync(settingsPath, "utf-8")).packages).toEqual([]);

		// User changes an UNRELATED setting via UI (this triggers save)
		await manager.setTheme("light");
		await manager.flush();

		// With the fix, packages should be preserved as [] (not reverted to startup value)
		const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));

		expect(savedSettings.packages).toEqual([]);
		expect(savedSettings.theme).toBe("light");
	});

	it("should preserve file changes to extensions array when changing unrelated setting", async () => {
		const settingsPath = join(agentDir, "settings.json");

		writeFileSync(
			settingsPath,
			JSON.stringify({
				theme: "dark",
				extensions: ["/old/extension.ts"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		// User externally updates extensions
		const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		currentSettings.extensions = ["/new/extension.ts"];
		writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

		// Change unrelated setting
		await manager.setDefaultThinkingLevel("high");
		await manager.flush();

		const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));

		// With the fix, extensions should be preserved (not reverted to startup value)
		expect(savedSettings.extensions).toEqual(["/new/extension.ts"]);
	});

	it("should preserve external project settings changes when updating unrelated project field", async () => {
		const projectSettingsPath = join(projectDir, ".candy", "settings.json");
		writeFileSync(
			projectSettingsPath,
			JSON.stringify({
				extensions: ["./old-extension.ts"],
				prompts: ["./old-prompt.md"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		const currentProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		currentProjectSettings.prompts = ["./new-prompt.md"];
		writeFileSync(projectSettingsPath, JSON.stringify(currentProjectSettings, null, 2));

		manager.setProjectExtensionPaths(["./updated-extension.ts"]);
		await manager.flush();

		const savedProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		expect(savedProjectSettings.prompts).toEqual(["./new-prompt.md"]);
		expect(savedProjectSettings.extensions).toEqual(["./updated-extension.ts"]);
	});

	it("should let in-memory project changes override external changes for the same project field", async () => {
		const projectSettingsPath = join(projectDir, ".candy", "settings.json");
		writeFileSync(
			projectSettingsPath,
			JSON.stringify({
				extensions: ["./initial-extension.ts"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		const currentProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		currentProjectSettings.extensions = ["./external-extension.ts"];
		writeFileSync(projectSettingsPath, JSON.stringify(currentProjectSettings, null, 2));

		manager.setProjectExtensionPaths(["./in-memory-extension.ts"]);
		await manager.flush();

		const savedProjectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf-8"));
		expect(savedProjectSettings.extensions).toEqual(["./in-memory-extension.ts"]);
	});
});
