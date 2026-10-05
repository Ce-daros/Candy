import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveConfigValue, resolveConfigValueUncached } from "../src/core/resolve-config-value.ts";
import * as shellModule from "../src/utils/shell.ts";

describe("resolveConfigValue", () => {
	let tempDir: string;
	let commandCache = new Map<string, string>();

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-config-value-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		commandCache = new Map();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		vi.restoreAllMocks();
	});

	test("resolves literals, environment templates, and escapes", async () => {
		process.env.TEST_CONFIG_LEFT = "left";
		process.env.TEST_CONFIG_RIGHT = "right";
		try {
			expect(await resolveConfigValue("literal-key")).toBe("literal-key");
			expect(await resolveConfigValue("$TEST_CONFIG_LEFT")).toBe("left");
			expect(await resolveConfigValue("$" + "{TEST_CONFIG_LEFT}_$TEST_CONFIG_RIGHT")).toBe("left_right");
			expect(await resolveConfigValue("$$TEST_CONFIG_LEFT")).toBe("$TEST_CONFIG_LEFT");
			expect(await resolveConfigValue("$!literal-$TEST_CONFIG_RIGHT")).toBe("!literal-right");
		} finally {
			delete process.env.TEST_CONFIG_LEFT;
			delete process.env.TEST_CONFIG_RIGHT;
		}
	});

	test("uses credential-scoped environment before process.env", async () => {
		process.env.TEST_CONFIG_SCOPED = "process";
		try {
			expect(await resolveConfigValue("$TEST_CONFIG_SCOPED", { TEST_CONFIG_SCOPED: "credential" })).toBe(
				"credential",
			);
		} finally {
			delete process.env.TEST_CONFIG_SCOPED;
		}
	});

	test("executes shell commands and trims their output", async () => {
		expect(await resolveConfigValue("!echo '  spaced-key  '")).toBe("spaced-key");
		expect(await resolveConfigValue("!printf 'line1\\nline2'")).toBe("line1\nline2");
		expect(await resolveConfigValue("!echo 'hello world' | tr ' ' '-'")).toBe("hello-world");
	});

	test.each(["!exit 1", "!nonexistent-command-12345"])("reports command failures: %s", async (command) => {
		await expect(resolveConfigValue(command)).rejects.toThrow();
	});

	test("returns undefined for a successful command with empty output", async () => {
		expect(await resolveConfigValue("!printf ''")).toBeUndefined();
	});

	test("cancels a running shell command with its owning operation", async () => {
		const controller = new AbortController();
		const pending = resolveConfigValue("!sleep 5", undefined, { signal: controller.signal });
		setTimeout(() => controller.abort(), 25);
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	test("caches successful commands only within their runtime cache", async () => {
		const counterFile = join(tempDir, "counter");
		writeFileSync(counterFile, "0");
		const escapedPath = counterFile.replace(/\\/g, "/").replace(/"/g, '\\"');
		const success = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; echo value'`;

		expect(await resolveConfigValue(success, undefined, { cache: commandCache })).toBe("value");
		expect(await resolveConfigValue(success, undefined, { cache: commandCache })).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("1");

		commandCache.clear();
		expect(await resolveConfigValue(success, undefined, { cache: commandCache })).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("2");

		const failure = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; exit 1'`;
		await expect(resolveConfigValue(failure, undefined, { cache: commandCache })).rejects.toThrow(
			"Shell command failed",
		);
		await expect(resolveConfigValue(failure, undefined, { cache: commandCache })).rejects.toThrow(
			"Shell command failed",
		);
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("4");
	});

	test("does not cache environment values", async () => {
		process.env.TEST_CONFIG_DYNAMIC = "first";
		try {
			expect(await resolveConfigValue("$TEST_CONFIG_DYNAMIC")).toBe("first");
			process.env.TEST_CONFIG_DYNAMIC = "second";
			expect(await resolveConfigValue("$TEST_CONFIG_DYNAMIC")).toBe("second");
		} finally {
			delete process.env.TEST_CONFIG_DYNAMIC;
		}
	});

	test("uncached resolution executes a command on every call", async () => {
		const counterFile = join(tempDir, "uncached-counter");
		writeFileSync(counterFile, "0");
		const escapedPath = counterFile.replace(/\\/g, "/").replace(/"/g, '\\"');
		const command = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; echo value'`;
		expect(await resolveConfigValueUncached(command)).toBe("value");
		expect(await resolveConfigValueUncached(command)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("2");
	});

	test("uses stdin when the configured Windows shell requires it", async () => {
		if (process.platform === "win32") return;
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		vi.spyOn(shellModule, "getShellConfig").mockReturnValue({
			shell: "/bin/bash",
			args: ["-s"],
			commandTransport: "stdin",
		});
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			const expansion = "$" + "{name}";
			expect(await resolveConfigValueUncached(`!name='World'; echo "Hello, ${expansion}!"`)).toBe("Hello, World!");
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		}
	});
});
