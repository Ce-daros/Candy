import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInteractiveSmoke, type InteractiveSmoke } from "./fixtures/interactive-smoke.ts";

type InteractiveState = {
	inputMode: string;
	presentation: { surface: string | undefined };
	footer: {
		getPowerbarSelector(): string | undefined;
		getHighlightedModel(): { id: string } | undefined;
	};
	defaultEditor: { getText(): string; setText(text: string): void };
	pendingUserInputs: string[];
};

let smoke: InteractiveSmoke | undefined;

async function start(): Promise<{ state: InteractiveState; terminal: VirtualTerminal }> {
	process.env.CANDY_OFFLINE = "1";
	process.env.CANDY_SKIP_VERSION_CHECK = "1";
	const terminal = new VirtualTerminal(80, 24);
	smoke = await createInteractiveSmoke({ terminal, animations: false });
	await smoke.mode.init();
	await terminal.waitForRender();
	return { state: smoke.mode as unknown as InteractiveState, terminal };
}

afterEach(async () => {
	await smoke?.cleanup();
	smoke = undefined;
});

describe("interactive presentation from terminal input", () => {
	it("opens Command only from a standalone slash key and keeps pasted slash messages literal", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("/");
		await terminal.waitForRender();
		expect(state.inputMode).toBe("command");
		expect(state.presentation.surface).toBe("command");
		terminal.sendInput("\x7f");
		await terminal.waitForRender();
		expect(state.inputMode).toBe("normal");
		expect(state.presentation.surface).toBeUndefined();
		terminal.sendInput("\x1b[200~/tree\x1b[201~");
		await terminal.waitForRender();
		expect(state.defaultEditor.getText()).toBe("/tree");
		expect(state.inputMode).toBe("normal");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(state.pendingUserInputs).toContain("/tree");
	});

	it("opens Help from a standalone question mark and keeps pasted questions literal", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("?");
		await terminal.waitForRender();
		expect(state.inputMode).toBe("help");
		expect(state.presentation.surface).toBe("help");
		const help = terminal.getViewport().join("\n");
		expect(help).toContain("Hotkeys");
		expect(help).toContain("Changelog");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.inputMode).toBe("normal");
		terminal.sendInput("\x1b[200~? what happened\x1b[201~");
		await terminal.waitForRender();
		expect(state.defaultEditor.getText()).toBe("? what happened");
		expect(state.presentation.surface).toBeUndefined();
	});

	it("shows session actions in History and project trust in Command", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("\x0c");
		terminal.sendInput("\t");
		terminal.sendInput("\x1b[A");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("history");
		const history = terminal.getViewport().join("\n");
		expect(history).toContain("New session");
		expect(history).toContain("Import");
		expect(history).toContain("Export");
		terminal.sendInput("\x1b");
		terminal.sendInput("\x1b");
		terminal.sendInput("/");
		terminal.sendInput("Project trust");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Privacy & Trust");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Saved decision:");
	});

	it("reloads configuration with Ctrl+R from the editor", async () => {
		const { terminal } = await start();
		terminal.sendInput("\x12");
		await vi.waitFor(() => expect(terminal.getViewport().join("\n")).toContain("Reloaded keybindings"));
	});

	it("starts a new session from History and returns to the composer", async () => {
		const { state, terminal } = await start();
		const previousSession = smoke!.runtime.session.sessionFile;
		terminal.sendInput("\x0c");
		terminal.sendInput("\t");
		terminal.sendInput("\x1b[A");
		terminal.sendInput("New session");
		terminal.sendInput("\r");
		await vi.waitFor(() => expect(smoke!.runtime.session.sessionFile).not.toBe(previousSession));
		await terminal.waitForRender();
		expect(state.presentation.surface).toBeUndefined();
		expect(state.defaultEditor.getText()).toBe("");
	});

	it("routes both selector directions and restores the highlighted model", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("\x0c");
		expect(state.footer.getPowerbarSelector()).toBe("model");
		terminal.sendInput("\x1b[C");
		const highlighted = state.footer.getHighlightedModel()?.id;
		expect(highlighted).toBe("candy-off");
		terminal.sendInput("\x1b[B");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("details");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.footer.getPowerbarSelector()).toBe("model");
		expect(state.footer.getHighlightedModel()?.id).toBe(highlighted);
		terminal.sendInput("\x1b[A");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("sources");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.footer.getPowerbarSelector()).toBe("model");
		terminal.sendInput("\t");
		expect(state.footer.getPowerbarSelector()).toBe("thinking");
		terminal.sendInput("\x1b[A");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("history");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.footer.getPowerbarSelector()).toBe("thinking");
		terminal.sendInput("\x1b[B");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("agent");
	});

	it("does not open Details for an unmatched search and preserves the query after Sources", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("\x0c");
		terminal.sendInput("z");
		terminal.sendInput("z");
		await terminal.waitForRender();
		expect(state.footer.getHighlightedModel()).toBeUndefined();
		terminal.sendInput("\x1b[B");
		expect(state.presentation.surface).toBeUndefined();
		terminal.sendInput("\x1b[A");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("sources");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.footer.getHighlightedModel()).toBeUndefined();
		expect(terminal.getViewport().join("\n")).toContain("Model › zz");
	});

	it("replaces the runtime for a clone and a switch using persisted faux sessions", async () => {
		await start();
		const runtime = smoke!.runtime;
		const initialFile = runtime.session.sessionFile;
		const leaf = runtime.session.sessionManager.getLeafId();
		expect(leaf).toBeTruthy();
		const clone = await runtime.fork(leaf!, { position: "at" });
		expect(clone.cancelled).toBe(false);
		expect(runtime.session.sessionFile).not.toBe(initialFile);
		const sessions = await SessionManager.list(smoke!.harness.tempDir, join(smoke!.harness.tempDir, "sessions"));
		const other = sessions.find((session) => session.firstMessage === "Another session");
		expect(other).toBeDefined();
		const switched = await runtime.switchSession(other!.path);
		expect(switched.cancelled).toBe(false);
		expect(runtime.session.sessionFile).toBe(other!.path);
	});

	it("keeps History reachable from an Off-only model and ignores Shift+Tab", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("\x0c");
		terminal.sendInput("\x1b[Z");
		expect(state.footer.getPowerbarSelector()).toBe("model");
		terminal.sendInput("\x1b[C");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(smoke!.runtime.session.model?.id).toBe("candy-off");
		terminal.sendInput("\x0c");
		terminal.sendInput("\t");
		expect(state.footer.getPowerbarSelector()).toBe("thinking");
		expect(terminal.getViewport().join("\n")).toContain("Off");
		terminal.sendInput("\x1b[A");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("history");
	});

	it("returns from skill configuration to Skills and continues navigation", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("\x0c");
		terminal.sendInput("\t");
		terminal.sendInput("\x1b[B");
		terminal.sendInput("Skills");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		terminal.sendInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 100));
		await terminal.waitForRender();
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Show in Command");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Search: Skills");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.footer.getPowerbarSelector()).toBe("thinking");
	});

	it("returns to Thinking after switching sessions without inserting the old last user message", async () => {
		const { state, terminal } = await start();
		expect(state.defaultEditor.getText()).toBe("");
		terminal.sendInput("\x0c");
		terminal.sendInput("\t");
		terminal.sendInput("\x1b[A");
		terminal.sendInput("Resume");
		terminal.sendInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 200));
		await terminal.waitForRender();
		terminal.sendInput("Another");
		terminal.sendInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 200));
		await terminal.waitForRender();
		expect(
			smoke!.runtime.session.messages.some(
				(message) => message.role === "user" && JSON.stringify(message.content).includes("Another session"),
			),
			terminal.getViewport().join("\n"),
		).toBe(true);
		expect(state.footer.getPowerbarSelector()).toBe("thinking");
		expect(state.defaultEditor.getText()).toBe("");
	});
});
