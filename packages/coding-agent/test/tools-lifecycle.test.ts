import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

vi.mock("../src/utils/tools-manager.ts", () => ({ ensureTool: async () => "rg" }));

const directories: string[] = [];
const outputFiles: string[] = [];

function directory(): string {
	const path = mkdtempSync(join(tmpdir(), "candy-tools-lifecycle-"));
	directories.push(path);
	return path;
}

afterEach(() => {
	vi.unstubAllEnvs();
	for (const path of outputFiles.splice(0)) rmSync(path, { force: true });
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("output file lifecycle", () => {
	it("reports write errors that arrive before the accumulator is closed", async () => {
		const output = new OutputAccumulator({ maxBytes: 1, tempFilePrefix: `${directory()}/missing/output` });
		output.append(Buffer.from("output"));
		await setImmediate();
		await expect(output.closeTempFile()).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("returns only after the bash output file contains the full output", async () => {
		const text = "x".repeat(DEFAULT_MAX_BYTES + 1);
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from(text));
				return { exitCode: 0 };
			},
		};
		const result = await executeBashWithOperations("output", directory(), operations);
		expect(result.fullOutputPath).toBeDefined();
		outputFiles.push(result.fullOutputPath!);
		expect(readFileSync(result.fullOutputPath!, "utf-8")).toBe(text);
	});

	it("propagates asynchronous bash output file errors", async () => {
		const nonexistent = join(directory(), "missing");
		for (const name of ["TMP", "TEMP", "TMPDIR"]) vi.stubEnv(name, nonexistent);
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, 120));
				await setImmediate();
				return { exitCode: 0 };
			},
		};
		await expect(executeBashWithOperations("output", process.cwd(), operations)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});

describe("grep cancellation", () => {
	it("does not start ripgrep after cancellation during path lookup", async () => {
		const controller = new AbortController();
		const entered = Promise.withResolvers<void>();
		const lookup = Promise.withResolvers<boolean>();
		const tool = createGrepTool(directory(), {
			operations: {
				isDirectory: () => {
					entered.resolve();
					return lookup.promise;
				},
				readFile: () => "",
			},
		});
		const result = tool.execute("cancel-lookup", { pattern: "match" }, controller.signal);
		const rejected = expect(result).rejects.toThrow("Operation aborted");
		await entered.promise;
		controller.abort();
		lookup.resolve(true);
		await rejected;
	});

	it("rejects cancellation while asynchronously reading match context", async () => {
		const cwd = directory();
		writeFileSync(join(cwd, "match.txt"), "before\nmatch\nafter\n");
		const controller = new AbortController();
		const entered = Promise.withResolvers<void>();
		const read = Promise.withResolvers<string>();
		const tool = createGrepTool(cwd, {
			operations: {
				isDirectory: () => true,
				readFile: () => {
					entered.resolve();
					return read.promise;
				},
			},
		});
		const result = tool.execute("cancel-context", { pattern: "match", context: 1 }, controller.signal);
		const rejected = expect(result).rejects.toThrow("Operation aborted");
		await entered.promise;
		controller.abort();
		await rejected;
		read.resolve("before\nmatch\nafter\n");
	});
});
