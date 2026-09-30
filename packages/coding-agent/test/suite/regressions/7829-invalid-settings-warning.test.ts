import { Container } from "@candy/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntimeDiagnostic } from "../../../src/core/agent-session-services.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness } from "../harness.ts";

function render(container: Container): string {
	return container.children.flatMap((child) => child.render(120)).join("\n");
}

describe("issue #7829 invalid settings warning", () => {
	beforeAll(() => initTheme("dark"));

	it("renders startup diagnostics inside the transcript", async () => {
		const harness = await createHarness();
		const previousOffline = process.env.CANDY_OFFLINE;
		process.env.CANDY_OFFLINE = "1";
		try {
			const chatContainer = new Container();
			const startupDiagnostics: AgentSessionRuntimeDiagnostic[] = [
				{
					type: "warning",
					message: "Invalid settings file /tmp/settings.json: malformed JSON",
				},
			];
			const context = {
				init: vi.fn(async () => {}),
				options: { startupDiagnostics },
				chatContainer,
				outputPad: 1,
				renderer: { requestRender: vi.fn() },
				version: "test",
				showWarning: (InteractiveMode.prototype as unknown as { showWarning(message: string): void }).showWarning,
				session: harness.session,
				runtimeHost: { models: harness.modelRuntime },
				checkForPackageUpdates: vi.fn().mockResolvedValue([]),
				checkTmuxKeyboardSetup: vi.fn().mockResolvedValue(undefined),
				maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
				getUserInput: vi.fn(() => new Promise<string>(() => {})),
			};
			const run = (InteractiveMode.prototype as unknown as { run(this: typeof context): Promise<void> }).run;

			void run.call(context);

			await vi.waitFor(() => {
				const output = render(chatContainer).replace(/\u001b\[[0-9;]*m/g, "");
				expect(output).toContain("Warning");
				expect(output).toContain("Invalid settings file /tmp/settings.json: malformed JSON");
			});
		} finally {
			if (previousOffline === undefined) delete process.env.CANDY_OFFLINE;
			else process.env.CANDY_OFFLINE = previousOffline;
			await harness.cleanup();
		}
	});
});
