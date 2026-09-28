import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("isolates smoke launcher skill search roots from the user profile", () => {
	const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
	const output = execFileSync(
		process.execPath,
		[join(repository, "scripts", "interactive-smoke.mjs"), "--probe-isolation"],
		{
			cwd: repository,
			encoding: "utf8",
		},
	);
	const probe = JSON.parse(output) as {
		home: string;
		cwd: string;
		temp: string;
		agentDir: string;
		workspaceBoundary: boolean;
		tempBoundary: boolean;
	};
	const isolation = dirname(probe.home);
	expect(probe.cwd).toBe(join(isolation, "workspace"));
	expect(probe.temp).toBe(join(isolation, "temp"));
	expect(probe.agentDir).toBe(join(isolation, "agent"));
	expect(probe.home.startsWith(`${homedir()}${sep}`)).toBe(false);
	expect(probe.cwd.startsWith(`${repository}${sep}`)).toBe(false);
	expect(probe.workspaceBoundary).toBe(true);
	expect(probe.tempBoundary).toBe(true);
}, 10000);
