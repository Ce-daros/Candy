import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CombinedAutocompleteProvider, Container } from "@candy/tui";
import { describe, expect, it, vi } from "vitest";
import type { CommandPanelAction } from "../src/modes/interactive/components/command-panel.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { exportSessionHtml } from "../src/presentation/session-html-export.ts";

vi.mock("../src/presentation/session-html-export.ts", () => ({
	exportSessionHtml: vi.fn(async (_session: unknown, outputPath?: string) => outputPath ?? "default.html"),
}));

describe("InteractiveMode local Command and Actions", () => {
	it("keeps only Debug in Command", () => {
		const getActions = Reflect.get(InteractiveMode.prototype, "getLocalCommandActions") as () => CommandPanelAction[];
		expect(getActions().map((action) => action.name)).toEqual(["debug"]);
	});

	it("exports JSONL and HTML from explicit path arguments", async () => {
		initTheme("dark");
		const context = {
			session: {
				history: { exportToJsonl: vi.fn((path: string) => path) },
			},
			showStatus: vi.fn(),
			showError: vi.fn(),
		};
		const exportCommand = Reflect.get(InteractiveMode.prototype, "handleExportCommand") as (
			this: typeof context,
			path?: string,
		) => Promise<void>;

		await exportCommand.call(context, "session.jsonl");
		await exportCommand.call(context, "report.html");

		expect(context.session.history.exportToJsonl).toHaveBeenCalledWith("session.jsonl");
		expect(exportSessionHtml).toHaveBeenCalledWith(context.session, "report.html", { themeName: "dark" });
		expect(context.showStatus).toHaveBeenCalledWith("Session exported to: report.html");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("renames the current session using the Actions argument", () => {
		initTheme("dark");
		let name: string | undefined;
		const context = {
			session: {
				execution: {
					setSessionName: vi.fn((value: string) => {
						name = value;
					}),
				},
			},
			sessionManager: { getSessionName: () => name },
			chatContainer: new Container(),
			showWarning: vi.fn(),
			renderer: { requestRender: vi.fn() },
		};
		const rename = Reflect.get(InteractiveMode.prototype, "handleNameCommand") as (
			this: typeof context,
			name: string,
		) => void;

		rename.call(context, "  Research session  ");

		expect(context.session.execution.setSessionName).toHaveBeenCalledWith("Research session");
		expect(context.sessionManager.getSessionName()).toBe("Research session");
		expect(context.renderer.requestRender).toHaveBeenCalledOnce();
		expect(context.showWarning).not.toHaveBeenCalled();
	});

	it("returns action failures to the Command argument input", async () => {
		const context = {
			session: {
				history: {
					exportToJsonl: vi.fn(() => {
						throw new Error("Disk full");
					}),
				},
			},
			showStatus: vi.fn(),
		};
		const exportCommand = Reflect.get(InteractiveMode.prototype, "handleExportCommand") as (
			this: typeof context,
			path: string,
		) => Promise<void>;

		await expect(exportCommand.call(context, "session.jsonl")).rejects.toThrow("Failed to export session: Disk full");
		const rename = Reflect.get(InteractiveMode.prototype, "handleNameCommand") as (name: string) => void;
		expect(() => rename(" ")).toThrow("Enter a session name");
	});

	it("completes and executes quoted paths as one Command argument", async () => {
		const directory = mkdtempSync(join(tmpdir(), "candy-command-path-"));
		expect(directory).not.toBe(process.cwd());
		try {
			writeFileSync(join(directory, "会话 文档.jsonl"), "{}\n");
			writeFileSync(join(directory, "suffix target.jsonl"), "{}\n");
			const complete = Reflect.get(InteractiveMode.prototype, "completeCommandArguments") as (
				input: string,
				signal: AbortSignal,
				force: boolean,
			) => Promise<{ value: string; label: string }[] | null>;
			const context = {
				sessionManager: { getCwd: () => directory },
				createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider(directory),
				completeCommandArguments(input: string, signal: AbortSignal, force: boolean) {
					return complete.call(context, input, signal, force);
				},
				handleExportCommand: vi.fn(async (_path?: string) => {}),
				handleImportCommand: vi.fn(async (_path: string) => "edit" as const),
			};
			const getActions = Reflect.get(InteractiveMode.prototype, "getSessionCommandActions") as (
				this: typeof context,
			) => CommandPanelAction[];
			const actions = getActions.call(context);
			const exportAction = actions.find((action) => action.name === "Export")!;
			const importAction = actions.find((action) => action.name === "Import")!;
			const signal = new AbortController().signal;
			const fullLine = await context.completeCommandArguments("before suffix", signal, true);
			expect(fullLine).toContainEqual({ value: 'before "suffix target.jsonl"', label: "suffix target.jsonl" });

			const completions = await exportAction.getArgumentCompletions?.("会话 文", signal);
			expect(completions).toContainEqual({ value: '"会话 文档.jsonl"', label: "会话 文档.jsonl" });
			const quoted = await importAction.getArgumentCompletions?.("'会话 文", signal);
			expect(quoted).toContainEqual({ value: '"会话 文档.jsonl"', label: "会话 文档.jsonl" });
			await exportAction.execute('"会话 文档.jsonl"');
			await exportAction.execute("");
			expect(context.handleExportCommand).toHaveBeenNthCalledWith(1, join(directory, "会话 文档.jsonl"));
			expect(context.handleExportCommand).toHaveBeenNthCalledWith(2, undefined);
			await expect(importAction.execute('"会话 文档.jsonl"')).resolves.toBe("edit");
			expect(context.handleImportCommand).toHaveBeenCalledWith(join(directory, "会话 文档.jsonl"));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
