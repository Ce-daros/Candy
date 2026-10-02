import { join } from "node:path";
import { fauxAssistantMessage } from "@candy/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { SessionDiscovery } from "../src/core/session-history.ts";
import type { KeybindingsManager } from "../src/presentation/keybindings.ts";
import { createInteractiveSmoke, type InteractiveSmoke } from "./fixtures/interactive-smoke.ts";

type InteractiveState = {
	inputMode: string;
	keybindings: KeybindingsManager;
	presentation: { surface: string | undefined };
	footer: {
		isPowerbarIdle(): boolean;
		getHighlightedModel(): { id: string } | undefined;
	};
	defaultEditor: { getText(): string; setText(text: string): void };
	pendingUserInputs: Array<{ text: string }>;
};

const tipMarkers = [
	"psst, tap",
	"for Actions.",
	"to change thinking effort.",
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
	options: { empty?: boolean; animations?: boolean; columns?: number; rows?: number } = {},
): Promise<{ state: InteractiveState; terminal: VirtualTerminal }> {
	process.env.CANDY_OFFLINE = "1";
	const terminal = new VirtualTerminal(options.columns ?? 80, options.rows ?? 24);
	smoke = await createInteractiveSmoke({ terminal, animations: options.animations ?? false, empty: options.empty });
	await smoke.mode.init();
	await terminal.waitForRender();
	return { state: smoke.mode as unknown as InteractiveState, terminal };
}

afterEach(async () => {
	await smoke?.cleanup();
	smoke = undefined;
});

describe("interactive presentation from terminal input", () => {
	it.each([499, 500])("opens Actions only when two Esc presses are less than 500ms apart (%sms)", async (elapsed) => {
		const { state, terminal } = await start();
		const time = vi.spyOn(Date, "now");
		try {
			time.mockReturnValue(1000);
			terminal.sendInput("\x1b");
			expect(state.presentation.surface).toBeUndefined();
			time.mockReturnValue(1000 + elapsed);
			terminal.sendInput("\x1b");
			expect(state.presentation.surface).toBe(elapsed < 500 ? "actions" : undefined);
		} finally {
			time.mockRestore();
		}
		await terminal.waitForRender();
	});

	it("aborts the running faux response with Escape before Actions can open", async () => {
		const { state, terminal } = await start();
		let responseStarted = false;
		smoke!.harness.setResponses([
			(_context, options) =>
				new Promise((resolve) => {
					options!.signal!.addEventListener("abort", () => resolve(fauxAssistantMessage("cancelled")), {
						once: true,
					});
					responseStarted = true;
				}),
		]);
		const response = smoke!.runtime.session.execution.prompt("start response");
		await vi.waitFor(() => expect(responseStarted).toBe(true));
		expect(smoke!.runtime.session.execution.isStreaming).toBe(true);
		terminal.sendInput("\x1b");
		await response;
		await vi.waitFor(() => expect(smoke!.runtime.session.execution.isStreaming).toBe(false));
		expect(state.presentation.surface).toBeUndefined();
		const last = smoke!.runtime.session.execution.messages.at(-1)!;
		expect(last.role).toBe("assistant");
		if (last.role === "assistant") expect(last.stopReason).toBe("aborted");
	});

	it("exits each Shell tier with Escape before opening Actions", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("!");
		terminal.sendInput("!");
		expect(state.inputMode).toBe("shell-no-context");
		terminal.sendInput("\x1b");
		expect(state.inputMode).toBe("shell");
		terminal.sendInput("\x1b");
		expect(state.inputMode).toBe("normal");
		expect(state.presentation.surface).toBeUndefined();
		terminal.sendInput("\x1b");
		expect(state.presentation.surface).toBeUndefined();
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("actions");
	});

	it("restores the Actions list position after returning from Behavior", async () => {
		const { state, terminal } = await start({ columns: 80 });
		terminal.sendInput("\x1b");
		terminal.sendInput("\x1b");
		for (let index = 0; index < 16; index++) terminal.sendInput("\x1b[B");
		await terminal.waitForRender();
		const before = plainText(terminal);
		expect(before).toContain("♦ Behavior ♦");
		expect(before).not.toContain("Current Model");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(plainText(terminal)).toContain("Steering: one-at-a-time");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("actions");
		expect(plainText(terminal)).toBe(before);
	});

	it("keeps a non-empty draft when Esc is pressed twice", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("keep this draft");
		terminal.sendInput("\x1b");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBeUndefined();
		expect(state.defaultEditor.getText()).toBe("keep this draft");
	});

	it("opens Actions immediately after cancelling an animated model preview", async () => {
		const { state, terminal } = await start({ animations: true });
		terminal.sendInput("\x0c");
		terminal.sendInput("\x1b[C");
		terminal.sendInput("\x1b");
		expect(state.footer.isPowerbarIdle()).toBe(true);
		terminal.sendInput("\x1b");
		terminal.sendInput("\x1b");
		expect(state.presentation.surface).toBe("actions");
		await vi.waitFor(() => expect(plainText(terminal)).toContain("Current Model"));
		expect(smoke!.runtime.session.selection.model?.id).toBe("candy-reasoning");
	});

	it("accepts draft input immediately after cancelling an animated model preview", async () => {
		const { state, terminal } = await start({ animations: true });
		terminal.sendInput("\x0c");
		terminal.sendInput("\x1b");
		terminal.sendInput("draft");
		await terminal.waitForRender();
		expect(state.defaultEditor.getText()).toBe("draft");
		expect(state.presentation.surface).toBeUndefined();
	});

	it("requires consecutive Escape presses after other input", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("\x1b");
		terminal.sendInput("x");
		terminal.sendInput("\x7f");
		terminal.sendInput("\x1b");
		expect(state.presentation.surface).toBeUndefined();
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("actions");
	});

	it.each(["tree", "fork", "resume"] as const)(
		"opens %s through its custom shortcut and returns to Actions",
		async (action) => {
			const { state, terminal } = await start();
			state.keybindings.setUserBindings({ [`app.session.${action}`]: "ctrl+e" });
			terminal.sendInput("\x05");
			await terminal.waitForRender();
			expect(state.presentation.surface).toBe("actions");
			expect(plainText(terminal)).not.toContain("Search:");
			terminal.sendInput("\x1b");
			await terminal.waitForRender();
			expect(state.presentation.surface).toBe("actions");
			expect(plainText(terminal)).toContain("Search:");
			terminal.sendInput("\x1b");
			await terminal.waitForRender();
			expect(state.footer.isPowerbarIdle()).toBe(true);
		},
	);

	it("uses a custom effort shortcut during model search without applying the preview", async () => {
		const { state, terminal } = await start();
		state.keybindings.setUserBindings({ "app.thinking.cycle": "ctrl+y" });
		terminal.sendInput("\x0c");
		for (const char of "Off") terminal.sendInput(char);
		const previous = smoke!.runtime.session.selection.thinkingLevel;
		terminal.sendInput("\x19");
		await terminal.waitForRender();
		expect(smoke!.runtime.session.selection.thinkingLevel).not.toBe(previous);
		expect(smoke!.runtime.session.selection.model?.id).toBe("candy-reasoning");
		expect(state.footer.getHighlightedModel()?.id).toBe("candy-off");
		expect(plainText(terminal)).toContain("Model › Off");
	});

	it("opens Current Model after a cancelled preview and returns to an idle composer", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("\x0c");
		terminal.sendInput("\x1b[C");
		terminal.sendInput("\x1b");
		terminal.sendInput("\x1b");
		terminal.sendInput("\x1b");
		terminal.sendInput("Current Model");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("details");
		expect(plainText(terminal)).toContain("candy-reasoning");
		expect(plainText(terminal)).toContain("Default thinking");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("actions");
		expect(plainText(terminal)).toContain("Search: Current Model");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBeUndefined();
		expect(state.footer.isPowerbarIdle()).toBe(true);
		terminal.sendInput("next draft");
		expect(state.defaultEditor.getText()).toBe("next draft");
	});

	it.each([80, 120])(
		"returns from animated session details with Actions search and selection intact at %s columns",
		async (columns) => {
			const { terminal } = await start({ animations: true, columns, rows: columns === 80 ? 24 : 36 });
			terminal.sendInput("\x1b");
			terminal.sendInput("\x1b");
			await vi.waitFor(() => expect(plainText(terminal)).toContain("New session"));
			terminal.sendInput("Session details");
			await terminal.waitForRender();
			terminal.sendInput("\r");
			await vi.waitFor(() => expect(plainText(terminal)).toContain("Session Info"));
			terminal.sendInput("\x1b");
			await vi.waitFor(() => expect(plainText(terminal)).toContain("Search: Session details"));
			await vi.waitFor(() => expect(plainText(terminal)).toContain("♦ Session details ♦"));
			terminal.sendInput("\r");
			terminal.sendInput("\x1b");
			await vi.waitFor(() => expect(plainText(terminal)).toContain("Search: Session details"));
		},
	);
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
		for (const char of "zz") terminal.sendInput(char);
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

	it("shows session actions in Actions and project trust in Command", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("\x1b");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("actions");
		expect(plainText(terminal)).toContain("New session");
		terminal.sendInput("port");
		await terminal.waitForRender();
		expect(plainText(terminal)).toContain("Import");
		expect(plainText(terminal)).toContain("Export");
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

	it("starts a new session from Actions and returns to the composer", async () => {
		const { state, terminal } = await start();
		const previousSession = smoke!.runtime.session.execution.sessionFile;
		terminal.sendInput("\x1b");
		terminal.sendInput("\x1b");
		terminal.sendInput("New session");
		terminal.sendInput("\r");
		await vi.waitFor(() => expect(smoke!.runtime.session.execution.sessionFile).not.toBe(previousSession));
		await terminal.waitForRender();
		expect(state.presentation.surface).toBeUndefined();
		expect(state.defaultEditor.getText()).toBe("");
	});

	it.each([80, 120])(
		"ignores Up, Down and Tab during model search and preserves the draft at %s columns",
		async (columns) => {
			const { state, terminal } = await start({ columns });
			terminal.sendInput("a draft");
			terminal.sendInput("\x0c");
			for (const char of "Candy") terminal.sendInput(char);
			terminal.sendInput("\x1b[C");
			await terminal.waitForRender();
			const highlighted = state.footer.getHighlightedModel()?.id;
			const active = smoke!.runtime.session.selection.model;
			for (const key of ["\x1b[A", "\x1b[B", "\t"]) terminal.sendInput(key);
			await terminal.waitForRender();
			expect(state.presentation.surface).toBeUndefined();
			expect(state.footer.isPowerbarIdle()).toBe(false);
			expect(state.footer.getHighlightedModel()?.id).toBe(highlighted);
			expect(smoke!.runtime.session.selection.model).toBe(active);
			expect(state.defaultEditor.getText()).toBe("a draft");
			expect(plainText(terminal)).toContain("Model › Candy");
			terminal.sendInput("\x1b");
			await terminal.waitForRender();
			expect(state.footer.isPowerbarIdle()).toBe(true);
			expect(state.defaultEditor.getText()).toBe("a draft");
		},
	);

	it("keeps an unmatched model search intact when Up, Down and Tab are pressed", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("\x0c");
		for (const char of "zz") terminal.sendInput(char);
		for (const key of ["\x1b[A", "\x1b[B", "\t"]) terminal.sendInput(key);
		await terminal.waitForRender();
		expect(state.footer.getHighlightedModel()).toBeUndefined();
		expect(state.presentation.surface).toBeUndefined();
		expect(plainText(terminal)).toContain("Model › zz");
	});

	it("replaces the runtime for a clone and a switch using persisted faux sessions", async () => {
		await start();
		const runtime = smoke!.runtime;
		const initialFile = runtime.session.execution.sessionFile;
		const leaf = runtime.session.history.getLeafId();
		expect(leaf).toBeTruthy();
		const clone = await runtime.fork(leaf!, { position: "at" });
		expect(clone.cancelled).toBe(false);
		expect(runtime.session.execution.sessionFile).not.toBe(initialFile);
		const sessions = await SessionDiscovery.list(smoke!.harness.tempDir, join(smoke!.harness.tempDir, "sessions"));
		const other = sessions.find((session) => session.firstMessage === "Another session");
		expect(other).toBeDefined();
		const switched = await runtime.switchSession(other!.path);
		expect(switched.cancelled).toBe(false);
		expect(runtime.session.execution.sessionFile).toBe(other!.path);
	});

	it("cycles actual model effort during preview and keeps Actions reachable from an Off-only model", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("\x0c");
		terminal.sendInput("\x1b[C");
		const previous = smoke!.runtime.session.selection.thinkingLevel;
		terminal.sendInput("\x1b[Z");
		await terminal.waitForRender();
		expect(smoke!.runtime.session.selection.thinkingLevel).not.toBe(previous);
		expect(smoke!.runtime.session.selection.model?.id).toBe("candy-reasoning");
		expect(state.footer.getHighlightedModel()?.id).toBe("candy-off");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(smoke!.runtime.session.selection.model?.id).toBe("candy-off");
		terminal.sendInput("\x1b[Z");
		await terminal.waitForRender();
		expect(plainText(terminal)).toContain("Current model does not support thinking");
		terminal.sendInput("\x1b");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("actions");
	});

	it("opens Skills configuration directly and returns to Actions with its search intact", async () => {
		const { state, terminal } = await start();
		terminal.sendInput("\x1b");
		terminal.sendInput("\x1b");
		terminal.sendInput("Skills");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(plainText(terminal)).not.toContain("Show in Command");
		expect(plainText(terminal)).not.toContain("Search: Skills");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("actions");
		expect(plainText(terminal)).toContain("Search: Skills");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.footer.isPowerbarIdle()).toBe(true);
	});

	it("reuses the empty-session home after New session and keeps its tip stable while redrawing", async () => {
		const { state, terminal } = await start({ empty: true });
		const previousSession = smoke!.runtime.session.execution.sessionFile;
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

		terminal.sendInput("\x1b");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("actions");
		terminal.sendInput("New session");
		terminal.sendInput("\r");
		await vi.waitFor(() => expect(smoke!.runtime.session.execution.sessionFile).not.toBe(previousSession));
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
		smoke!.runtime.session.selection.clearModel();
		terminal.sendInput("keep this draft");
		terminal.sendInput("\r");
		await terminal.waitForRender();

		expect(state.pendingUserInputs).toEqual([]);
		expect(state.defaultEditor.getText()).toBe("keep this draft");
		expect(plainText(terminal)).toContain("No model selected");
	});

	it("clearing quick selection from Sources clears the active model on exit", async () => {
		const { state, terminal } = await start();
		expect(smoke!.runtime.session.selection.model).toBeDefined();
		terminal.sendInput("\x1b");
		terminal.sendInput("\x1b");
		terminal.sendInput("Sources");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(state.presentation.surface).toBe("sources");
		terminal.sendInput("Clear quick selection");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		terminal.sendInput("\x1b");
		await vi.waitFor(() => expect(state.presentation.surface).toBe("actions"));
		expect(smoke!.runtime.session.selection.model).toBeUndefined();
		await terminal.waitForRender();
		expect(plainText(terminal)).toContain("No models selected");
	});

	it("returns to the composer after switching sessions without inserting the old last user message", async () => {
		const { state, terminal } = await start();
		expect(state.defaultEditor.getText()).toBe("");
		terminal.sendInput("\x1b");
		terminal.sendInput("\x1b");
		terminal.sendInput("Resume");
		terminal.sendInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 200));
		await terminal.waitForRender();
		terminal.sendInput("Another");
		terminal.sendInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 200));
		await terminal.waitForRender();
		expect(
			smoke!.runtime.session.execution.messages.some(
				(message) => message.role === "user" && JSON.stringify(message.content).includes("Another session"),
			),
			terminal.getViewport().join("\n"),
		).toBe(true);
		expect(state.footer.isPowerbarIdle()).toBe(true);
		expect(state.defaultEditor.getText()).toBe("");
	});
});
