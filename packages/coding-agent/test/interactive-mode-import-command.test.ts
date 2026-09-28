import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionImportFileNotFoundError } from "../src/core/agent-session-runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ImportCommandContext = {
	clearStatusIndicator: () => void;
	runtimeHost: { importFromJsonl: (inputPath: string, cwdOverride?: string) => Promise<{ cancelled: boolean }> };
	showError: (message: string) => void;
	showStatus: (message: string) => void;
	showExtensionConfirm: (title: string, message: string) => Promise<boolean>;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
	promptForMissingSessionCwd: (error: unknown) => Promise<string | undefined>;
};

const handleImportCommand = Reflect.get(InteractiveMode.prototype, "handleImportCommand") as (
	this: ImportCommandContext,
	inputPath: string,
) => Promise<"edit" | undefined>;

const tempDirs: string[] = [];
function createInput(name: string): string {
	const directory = mkdtempSync(join(tmpdir(), "candy-import-test-"));
	tempDirs.push(directory);
	const inputPath = join(directory, name);
	writeFileSync(inputPath, "{}\n");
	return inputPath;
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createContext(importFromJsonl: ImportCommandContext["runtimeHost"]["importFromJsonl"]): ImportCommandContext {
	return {
		clearStatusIndicator: vi.fn(),
		runtimeHost: { importFromJsonl },
		showError: vi.fn(),
		showStatus: vi.fn(),
		showExtensionConfirm: vi.fn(async () => true),
		handleFatalRuntimeError: vi.fn(async () => {
			throw new Error("unexpected fatal error");
		}),
		promptForMissingSessionCwd: vi.fn(async () => undefined),
	};
}

describe("InteractiveMode import action", () => {
	it("passes a path with spaces directly to the session runtime", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const context = createContext(importFromJsonl);
		const inputPath = createInput("path with spaces 会话.jsonl");

		await handleImportCommand.call(context, inputPath);

		expect(context.showExtensionConfirm).toHaveBeenCalledWith(
			"Import session",
			`Replace current session with ${inputPath}?`,
		);
		expect(importFromJsonl).toHaveBeenCalledWith(inputPath);
		expect(context.showStatus).toHaveBeenCalledWith(`Session imported from: ${inputPath}`);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("preserves apostrophes in the explicit path", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const context = createContext(importFromJsonl);
		const inputPath = createInput("john's session.jsonl");

		await handleImportCommand.call(context, inputPath);

		expect(importFromJsonl).toHaveBeenCalledWith(inputPath);
	});

	it("rejects an empty path before replacing the session", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const context = createContext(importFromJsonl);

		await expect(handleImportCommand.call(context, "")).rejects.toThrow("Enter a session JSONL path");

		expect(context.showError).not.toHaveBeenCalled();
		expect(context.showExtensionConfirm).not.toHaveBeenCalled();
		expect(importFromJsonl).not.toHaveBeenCalled();
	});

	it("reports a missing input file without treating it as a fatal session error", async () => {
		const importFromJsonl = vi.fn(async () => {
			throw new SessionImportFileNotFoundError("/tmp/missing-session.jsonl");
		});
		const context = createContext(importFromJsonl);

		await expect(handleImportCommand.call(context, "/tmp/missing-session.jsonl")).rejects.toBeInstanceOf(
			SessionImportFileNotFoundError,
		);

		expect(context.showError).not.toHaveBeenCalled();
		expect(context.showExtensionConfirm).not.toHaveBeenCalled();
		expect(context.handleFatalRuntimeError).not.toHaveBeenCalled();
	});

	it("keeps the path editable when confirmation is cancelled", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const context = createContext(importFromJsonl);
		const inputPath = createInput("session.jsonl");
		context.showExtensionConfirm = vi.fn(async () => false);

		await expect(handleImportCommand.call(context, inputPath)).resolves.toBe("edit");
		expect(importFromJsonl).not.toHaveBeenCalled();
	});
});
