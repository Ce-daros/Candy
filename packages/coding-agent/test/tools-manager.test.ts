import type * as ChildProcess from "node:child_process";
import type * as Fs from "node:fs";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureTool, getLatestVersion, getToolPath, type ToolStatus } from "../src/utils/tools-manager.ts";

const originalOffline = process.env.CANDY_OFFLINE;

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		existsSync: vi.fn(() => false),
	};
});

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	return {
		...actual,
		spawnSync: vi.fn(() => ({ error: new Error("not found") })),
	};
});

afterEach(() => {
	if (originalOffline === undefined) delete process.env.CANDY_OFFLINE;
	else process.env.CANDY_OFFLINE = originalOffline;
	vi.unstubAllGlobals();
	vi.mocked(existsSync).mockReset().mockReturnValue(false);
	vi.mocked(spawnSync).mockReset().mockReturnValue(commandResult("", 1));
});

function commandResult(stdout: string, status = 0): ChildProcess.SpawnSyncReturns<Buffer<ArrayBuffer>> {
	const output = Buffer.from(stdout);
	const stderr = Buffer.alloc(0);
	return { pid: 1, output: [null, output, stderr], stdout: output, stderr, status, signal: null };
}

describe("getToolPath", () => {
	it.each(["8.3.1", "8.6.0"])("rejects fd %s without --no-require-git support", (version) => {
		vi.mocked(spawnSync).mockReturnValue(commandResult(`fd ${version}\n`));
		expect(getToolPath("fd")).toBeNull();
	});

	it.each(["8.7.0", "10.5.0"])("uses supported fd %s from PATH", (version) => {
		vi.mocked(spawnSync).mockReturnValue(commandResult(`fd ${version}\n`));
		expect(getToolPath("fd")).toBe("fd");
	});

	it("uses a supported fdfind when fd is outdated", () => {
		vi.mocked(spawnSync).mockImplementation((command) =>
			commandResult(command === "fdfind" ? "fd 8.7.0\n" : "fd 8.3.1\n"),
		);
		expect(getToolPath("fd")).toBe("fdfind");
	});

	it("skips an outdated managed fd before checking PATH", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(spawnSync).mockImplementation((command) =>
			commandResult(command === "fd" ? "fd 10.5.0\n" : "fd 8.3.1\n"),
		);
		expect(getToolPath("fd")).toBe("fd");
	});

	it("rejects a command whose version check exits unsuccessfully", () => {
		vi.mocked(spawnSync).mockReturnValue(commandResult("fd 10.5.0\n", 1));
		expect(getToolPath("fd")).toBeNull();
	});
});

function redirectResponse(location: string): Response {
	return new Response(null, { status: 302, headers: { location } });
}

describe("getLatestVersion", () => {
	it("resolves the version from the release page redirect", async () => {
		const fetchMock = vi.fn(async () => redirectResponse("https://github.com/sharkdp/fd/releases/tag/v10.4.2"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestVersion("sharkdp/fd")).resolves.toBe("10.4.2");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://github.com/sharkdp/fd/releases/latest",
			expect.objectContaining({ redirect: "manual" }),
		);
	});

	it("keeps tags without a v prefix intact", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => redirectResponse("https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0")),
		);

		await expect(getLatestVersion("BurntSushi/ripgrep")).resolves.toBe("15.2.0");
	});

	it("resolves relative redirect targets", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => redirectResponse("/sharkdp/fd/releases/tag/v10.4.2")),
		);

		await expect(getLatestVersion("sharkdp/fd")).resolves.toBe("10.4.2");
	});

	it("discards the redirect response body", async () => {
		const response = new Response("<html></html>", {
			status: 302,
			headers: { location: "https://github.com/sharkdp/fd/releases/tag/v10.4.2" },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response),
		);

		await expect(getLatestVersion("sharkdp/fd")).resolves.toBe("10.4.2");
		expect(response.bodyUsed).toBe(true);
	});

	it("fails clearly when the endpoint does not redirect", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);

		await expect(getLatestVersion("sharkdp/fd")).rejects.toThrow(
			"Failed to resolve latest sharkdp/fd release: HTTP 404 without redirect",
		);
	});

	it("fails clearly when the redirect does not point at a release tag", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => redirectResponse("https://github.com/login")),
		);

		await expect(getLatestVersion("sharkdp/fd")).rejects.toThrow(
			"Failed to resolve latest sharkdp/fd release: unexpected redirect to https://github.com/login",
		);
	});
});

describe("ensureTool", () => {
	it("reports status through a callback without writing to the console", async () => {
		process.env.CANDY_OFFLINE = "1";
		const statuses: ToolStatus[] = [];
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

		const result = await ensureTool("fd", (status) => statuses.push(status));

		expect(result).toBeUndefined();
		expect(statuses).toEqual([
			{
				type: "warning",
				message: "fd >= 8.7.0 not found. Offline mode enabled, skipping download.",
			},
		]);
		expect(consoleLog).not.toHaveBeenCalled();
		consoleLog.mockRestore();
	});

	it("surfaces the error cause chain when a download fails", async () => {
		delete process.env.CANDY_OFFLINE;
		const cause = new Error("connect ETIMEDOUT 140.82.113.3:443");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed", { cause });
			}),
		);
		const statuses: ToolStatus[] = [];

		const result = await ensureTool("fd", (status) => statuses.push(status));

		expect(result).toBeUndefined();
		expect(statuses).toEqual([
			{ type: "info", message: "fd >= 8.7.0 not found. Downloading..." },
			{
				type: "warning",
				message: "Failed to download fd: fetch failed: connect ETIMEDOUT 140.82.113.3:443",
			},
		]);
	});
});
