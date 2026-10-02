import type { TUI } from "@candy/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("LoginDialogComponent", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps device instructions visible while masking and submitting an API key", async () => {
		const dialog = new LoginDialogComponent({ requestRender: vi.fn() } as unknown as TUI, "example", vi.fn());
		dialog.showDeviceCode({
			type: "device_code",
			verificationUri: "https://example.test/activate",
			userCode: "ABCD-1234",
		});
		const submitted = dialog.showPrompt("API key", undefined, true);
		for (const character of "secret-value") dialog.handleInput(character);
		let rendered = stripAnsi(dialog.render(100).join("\n"));
		expect(rendered).toContain("https://example.test/activate");
		expect(rendered).toContain("ABCD-1234");
		expect(rendered).not.toContain("secret-value");
		dialog.handleInput("\r");
		expect(await submitted).toBe("secret-value");
		rendered = stripAnsi(dialog.render(100).join("\n"));
		expect(rendered).not.toContain("secret-value");
		dialog.showWaiting("Checking credentials…");
		rendered = stripAnsi(dialog.render(100).join("\n"));
		expect(rendered).toContain("ABCD-1234");
		expect(rendered).toContain("Checking credentials…");
		expect(rendered).not.toContain("─".repeat(50));
	});
});
