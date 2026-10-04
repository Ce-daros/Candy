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
import type { McpInteractionHandler, McpInteractionRequest } from "../../src/core/mcp/types.ts";
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
		codemode: process.argv.includes("--codemode"),
	});
	try {
		const interaction = process.argv.find((arg) => arg.startsWith("--mcp-interaction="))?.split("=")[1];
		if (interaction) {
			const request: McpInteractionRequest =
				interaction === "advanced-form"
					? {
							type: "elicitation",
							server: "smoke-fixture",
							request: {
								mode: "form",
								message: "Choose the fixture values",
								requestedSchema: {
									type: "object",
									properties: {
										color: {
											type: "string",
											title: "Color",
											oneOf: [
												{ const: "red", title: "Red" },
												{ const: "blue", title: "Blue" },
											],
											default: "blue",
										},
										tags: {
											type: "array",
											title: "Tags",
											items: {
												anyOf: [
													{ const: "red", title: "Red" },
													{ const: "blue", title: "Blue" },
												],
											},
											default: ["red"],
											minItems: 1,
											maxItems: 2,
										},
										email: {
											type: "string",
											title: "Email",
											format: "email",
											default: "person@example.test",
										},
									},
									required: ["color", "tags", "email"],
								},
							},
						}
					: interaction === "form"
						? {
								type: "elicitation",
								server: "smoke-fixture",
								request: {
									mode: "form",
									message: "Provide the fixture values",
									requestedSchema: {
										type: "object",
										properties: {
											label: { type: "string", title: "Label" },
											count: { type: "integer", title: "Count", minimum: 1 },
											approved: { type: "boolean", title: "Approved" },
											color: { type: "string", title: "Color", enum: ["red", "blue"] },
										},
										required: ["label", "count", "approved", "color"],
									},
								},
							}
						: interaction === "url"
							? {
									type: "elicitation",
									server: "smoke-fixture",
									request: {
										mode: "url",
										message: "Visit the fixture page",
										elicitationId: "smoke-url",
										url: "https://example.test/fixture",
									},
								}
							: { type: "authorization", server: "smoke-fixture", url: "https://example.test/authorize" };
			setTimeout(() => {
				const handler = Reflect.get(smoke.runtime.mcp, "interaction") as McpInteractionHandler | undefined;
				if (!handler) throw new Error("MCP interaction handler was not registered");
				void handler(request).then((result) => {
					process.stdout.write(`MCP_INTERACTION_RESULT ${JSON.stringify(result)}\n`);
				});
			}, 1000);
		}
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
			dialog.showDeviceCode({
				type: "device_code",
				verificationUri: "https://example.test/activate",
				userCode: "ABCD-1234",
			});
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
