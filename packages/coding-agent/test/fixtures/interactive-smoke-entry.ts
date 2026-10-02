import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { selectSession } from "../../src/cli/session-picker.ts";
import {
	createStartupTui,
	mountStartupContent,
	showFirstTimeSetup,
	showStartupInput,
	showStartupTrustSelector,
	startStartupTui,
} from "../../src/cli/startup-ui.ts";
import { SessionDiscovery } from "../../src/core/session-history.ts";
import { LoginDialogComponent } from "../../src/modes/interactive/components/login-dialog.ts";
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
		if (process.argv.includes("--startup-dialogs")) {
			const settings = smoke.harness.settingsManager;
			await showFirstTimeSetup(settings);
			await showStartupTrustSelector(settings, smoke.harness.tempDir, null);
			const sessions = () => SessionDiscovery.list(smoke.harness.tempDir, join(smoke.harness.tempDir, "sessions"));
			await selectSession(sessions, sessions, settings);
			await showStartupInput(settings, "Session name");
			const ui = await createStartupTui(settings);
			const dialog = new LoginDialogComponent(ui, "faux", () => {});
			const close = mountStartupContent(ui, settings, dialog);
			startStartupTui(ui, settings);
			dialog.showDeviceCode({ verificationUri: "https://example.test/activate", userCode: "ABCD-1234" });
			const submitted = await dialog.showPrompt("API key", undefined, true);
			if (submitted !== "fake-key") throw new Error("Expected the fixture's fake key");
			dialog.showWaiting("Checking credentials…");
			await new Promise((resolve) => setTimeout(resolve, 1200));
			await close();
			dialog.abort();
			ui.stop();
		}
		await smoke.mode.run();
	} finally {
		await smoke.cleanup();
	}
}
