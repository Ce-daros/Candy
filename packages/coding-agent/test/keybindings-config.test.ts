import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/presentation/keybindings.ts";

describe("keybindings configuration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function createAgentDir(config: Record<string, unknown>): string {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-keybindings-test-"));
		tempDirs.push(agentDir);
		fs.writeFileSync(path.join(agentDir, "keybindings.json"), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
		return agentDir;
	}

	it("loads current namespaced bindings without rewriting the file", () => {
		const agentDir = createAgentDir({
			"tui.select.confirm": "enter",
			"app.interrupt": "ctrl+x",
		});

		const pathBeforeLoad = fs.readFileSync(path.join(agentDir, "keybindings.json"), "utf-8");
		const keybindings = KeybindingsManager.create(agentDir);
		expect(fs.readFileSync(path.join(agentDir, "keybindings.json"), "utf-8")).toBe(pathBeforeLoad);

		expect(keybindings.getUserBindings()).toEqual({
			"tui.select.confirm": "enter",
			"app.interrupt": "ctrl+x",
		});
		const effective = keybindings.getEffectiveConfig();
		expect(effective["tui.select.confirm"]).toBe("enter");
		expect(effective["app.interrupt"]).toBe("ctrl+x");
	});
});
