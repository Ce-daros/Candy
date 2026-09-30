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
	pendingUserInputs: Array<{ text: string }>;
};

const tipMarkers = [
	"psst, tap",
	"in the Powerbar?",
	"model picked?",
	"curious about a model?",
	"command time, yayy",
	"need a hand?",
	"find a file. there it is.",
	"shell magic",
	"model shortlist",
	"fresh page",
	"still working?",
	"shell output just for you?",
	"take the other path, babe",
	"another life",
	"big draft energy?",
	"Terraria!",
	"the cake can wait.",
	"have some Candy",
	"take a little Candy",
	"stay determined, cutie",
	"one more day on the farm",
	"one more turn?",
];

function plainText(terminal: VirtualTerminal): string {
	return terminal
		.getViewport()
		.join("\n")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function homeFacts(text: string): string[] {
	return text.split("\n").filter((line) => line.includes("Candy (") || line.includes("context ·"));
}

function homeTip(text: string): string | undefined {
	return text.split("\n").find((line) => tipMarkers.some((marker) => line.includes(marker)));
}

let smoke: InteractiveSmoke | undefined;

async function start(
	options: { empty?: boolean } = {},
): Promise<{ state: InteractiveState; terminal: VirtualTerminal }> {
	process.env.CANDY_OFFLINE = "1";
	const terminal = new VirtualTerminal(80, 24);
	smoke = await createInteractiveSmoke({ terminal, animations: false, empty: options.empty });
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
		expect(state.pendingUserInputs).toContainEqual({ text: "/tree" });
	});

	it("opens Help from a standalone question mark and keeps pasted questions literal", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("?");
		await terminal.waitForRender();
		expect(state.inputMode).toBe("help");
		expect(state.presentation.surface).toBeUndefined();
		const help = terminal.getViewport().join("\n");
		expect(help).toContain("Hotkeys");
		expect(help).toContain("Changelog");
		expect(help).toMatch(/│ \? /);
		expect(help.indexOf("Hotkeys")).toBeLessThan(help.indexOf("│ ? "));
		terminal.sendInput("zz");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(state.inputMode).toBe("help");
		expect(state.pendingUserInputs).toEqual([]);
		terminal.sendInput("\x7f");
		terminal.sendInput("\x7f");
		terminal.sendInput("change");
		await terminal.waitForRender();
		expect(state.defaultEditor.getText()).toBe("change");
		const filtered = terminal.getViewport().join("\n");
		expect(filtered).toContain("Changelog");
		expect(filtered).not.toContain("Hotkeys");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Changelog");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.inputMode).toBe("help");
		expect(state.defaultEditor.getText()).toBe("change");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.inputMode).toBe("normal");
		expect(state.defaultEditor.getText()).toBe("");
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

	it("opens Skills configuration directly and returns to Agent without a command submenu", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("\x0c");
		terminal.sendInput("\t");
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\x1b[B");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("agent");
		expect(plainText(terminal)).toContain("Skills");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(plainText(terminal)).not.toContain("Show in Command");
		expect(plainText(terminal)).not.toContain("Search: Skills");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("agent");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.footer.getPowerbarSelector()).toBe("thinking");
	});

	it("reuses the empty-session home after New session and keeps its tip stable while redrawing", async () => {
		const { state, terminal } = await start({ empty: true });
		const previousSession = smoke!.runtime.session.sessionFile;
		const initial = plainText(terminal);
		const initialFacts = homeFacts(initial);
		const initialTip = homeTip(initial);
		expect(initialFacts).toHaveLength(2);
		expect(initialTip).toBeDefined();
		expect(initial).not.toContain("Loaded resources");
		expect(initial).not.toContain("New session started");

		terminal.resize(96, 30);
		await terminal.waitForRender();
		terminal.resize(80, 24);
		await terminal.waitForRender();
		expect(homeTip(plainText(terminal))).toBe(initialTip);

		terminal.sendInput("\x0c");
		terminal.sendInput("\t");
		terminal.sendInput("\x1b[A");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("history");
		terminal.sendInput("New session");
		terminal.sendInput("\r");
		await vi.waitFor(() => expect(smoke!.runtime.session.sessionFile).not.toBe(previousSession));
		await terminal.waitForRender();
		const nextHome = plainText(terminal);
		expect(homeFacts(nextHome)).toEqual(initialFacts);
		expect(homeTip(nextHome)).toBeDefined();
		expect(nextHome).not.toContain("Loaded resources");
		expect(nextHome).not.toContain("New session started");
		expect(state.presentation.surface).toBeUndefined();
	});

	it("keeps a submitted draft in the composer when no model is selected", async () => {
		const { state, terminal } = await start({ empty: true });
		smoke!.runtime.session.clearModel();
		terminal.sendInput("keep this draft");
		terminal.sendInput("\r");
		await terminal.waitForRender();

		expect(state.pendingUserInputs).toEqual([]);
		expect(state.defaultEditor.getText()).toBe("keep this draft");
		expect(plainText(terminal)).toContain("No model selected");
	});

	it("clearing quick selection from Sources clears the active model on exit", async () => {
		const { state, terminal } = await start();
		expect(smoke!.runtime.session.model).toBeDefined();
		terminal.sendInput("\x0c");
		terminal.sendInput("\x1b[A");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("sources");
		terminal.sendInput("Clear quick selection");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		terminal.sendInput("\x1b");
		await vi.waitFor(() => expect(state.presentation.surface).toBeUndefined());
		expect(smoke!.runtime.session.model).toBeUndefined();
		await terminal.waitForRender();
		expect(plainText(terminal)).toContain("No models selected");
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
