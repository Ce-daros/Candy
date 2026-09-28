import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createInteractiveSmoke, type InteractiveSmoke } from "./fixtures/interactive-smoke.ts";

let smoke: InteractiveSmoke | undefined;
afterEach(async () => {
	await smoke?.cleanup();
	smoke = undefined;
});

function text(terminal: VirtualTerminal): string {
	return terminal.getViewport().join("\n");
}

async function click(terminal: VirtualTerminal, label: string): Promise<void> {
	const row = terminal.getViewport().findIndex((line) => line.includes(label));
	expect(row).toBeGreaterThanOrEqual(0);
	terminal.sendInput(`\x1b[<0;2;${row + 1}M`);
	terminal.sendInput(`\x1b[<0;2;${row + 1}m`);
	await terminal.waitForRender();
}

describe("assistant transcript interaction", () => {
	it.each([false, true])(
		"links thinking runs and reveals TPS only from the reply marker (animations %s)",
		async (animations) => {
			process.env.CANDY_OFFLINE = "1";
			process.env.CANDY_SKIP_VERSION_CHECK = "1";
			const terminal = new VirtualTerminal(80, 30);
			smoke = await createInteractiveSmoke({ terminal, empty: true, transcript: true, animations });
			await smoke.mode.init();
			const prompt = smoke.runtime.session.prompt("pig pig pork 中文");
			await vi.waitFor(
				async () => {
					await terminal.waitForRender();
					expect(text(terminal)).toMatch(/[✧✦]/);
					expect(text(terminal)).toContain("Checking the first idea.");
				},
				{ timeout: 3000 },
			);
			expect(text(terminal)).not.toContain("TPS");
			await prompt;
			await terminal.waitForRender();
			const rows = terminal.getViewport();
			expect(rows.findIndex((line) => line.includes("◆ pig pig pork"))).toBe(3);
			expect(text(terminal)).toContain("▸ Checking the first idea.");
			expect(text(terminal)).toContain("▸ Checking a second idea");
			expect(text(terminal)).not.toContain("Thought");
			expect(rows.filter((line) => line.trim() === "│")).toHaveLength(3);
			expect(text(terminal)).not.toContain("TPS");
			await click(terminal, "✦ Final reply.");
			expect(text(terminal)).toMatch(/TPS [\d.]+ tok\/s/);
			await click(terminal, "✦ Final reply.");
			expect(text(terminal)).not.toContain("TPS");
			await click(terminal, "▸ Checking the first idea.");
			expect(text(terminal)).toContain("▾");
			expect(text(terminal)).toContain("▸ Checking a second idea");
			terminal.resize(120, 36);
			await terminal.waitForRender();
			await click(terminal, "✦ Final reply.");
			expect(text(terminal)).toContain("TPS");
			const sessionFile = smoke.runtime.session.sessionFile!;
			await smoke.runtime.switchSession(sessionFile);
			await terminal.waitForRender();
			expect(text(terminal)).not.toContain("TPS");
			await click(terminal, "✦ Final reply.");
			expect(text(terminal)).toContain("TPS");
			expect(smoke.runtime.session.messages.some((message) => message.role === "custom")).toBe(false);
		},
		15000,
	);
});
