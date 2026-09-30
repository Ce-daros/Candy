import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInteractiveSmoke } from "./interactive-smoke.ts";

globalThis.fetch = async () => {
	throw new Error("Network access is disabled in the interactive smoke fixture");
};

const animations = !process.argv.includes("--no-animations");
if (process.argv.includes("--probe-isolation")) {
	process.stdout.write(
		`${JSON.stringify({
			home: homedir(),
			cwd: process.cwd(),
			temp: tmpdir(),
			agentDir: process.env.CANDY_CODING_AGENT_DIR,
			workspaceBoundary: existsSync(join(process.cwd(), ".git")),
			tempBoundary: existsSync(join(tmpdir(), ".git")),
		})}\n`,
	);
} else {
	const smoke = await createInteractiveSmoke({
		animations,
		empty: process.argv.includes("--empty"),
		theme: process.argv.includes("--light") ? "light" : "dark",
		longModelName: process.argv.includes("--long-model-name"),
		transcript: process.argv.includes("--transcript"),
	});
	try {
		await smoke.mode.run();
	} finally {
		await smoke.cleanup();
	}
}
