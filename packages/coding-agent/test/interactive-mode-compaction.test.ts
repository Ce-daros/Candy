import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@candy/ai";
import { Container } from "@candy/tui";
import { describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { SessionPresentation } from "../src/modes/interactive/session-presentation.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("InteractiveMode compaction events", () => {
	test("repaints the context line when its rounded length changes", () => {
		let percent = 41.2;
		const context = {
			session: { getContextUsage: () => ({ percent }) },
			ui: { requestRender: vi.fn() },
			lastContextPercent: undefined as number | null | undefined,
		};
		const refresh = Reflect.get(InteractiveMode.prototype, "refreshContextLine") as (this: typeof context) => void;

		refresh.call(context);
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
		percent = 41.4;
		refresh.call(context);
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);

		percent = 42;
		refresh.call(context);
		expect(context.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	test("uses the cache miss notice setting for compaction and branch summary costs", () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const addCompactionCostNotice = Reflect.get(InteractiveMode.prototype, "addCompactionCostNotice") as (
			this: { chatContainer: Container; settingsManager: { getShowCacheMissNotices(): boolean } },
			notice: {
				type: "compaction_cost";
				kind: "compaction" | "branch_summary";
				usage: Usage;
			},
		) => void;

		initTheme("dark");
		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
		};
		addCompactionCostNotice.call(enabled, { type: "compaction_cost", kind: "compaction", usage });
		addCompactionCostNotice.call(enabled, {
			type: "compaction_cost",
			kind: "branch_summary",
			usage,
		});
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Compaction: 100 tokens billed (~$0.13)");
		expect(output).toContain("Branch summary: 100 tokens billed (~$0.13)");

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
		};
		addCompactionCostNotice.call(disabled, { type: "compaction_cost", kind: "compaction", usage });
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("renders each compaction cost after its summary", () => {
		const currentUsage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		};
		const previousUsage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
		};
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "current",
				parentId: "previous",
				timestamp: "2025-01-02T00:00:00Z",
				summary: "current summary",
				firstKeptEntryId: "kept",
				tokensBefore: 200,
				usage: currentUsage,
			},
			{
				type: "compaction",
				id: "previous",
				parentId: null,
				timestamp: "2025-01-01T00:00:00Z",
				summary: "previous summary",
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				usage: previousUsage,
			},
		];
		const fakeThis = {
			sessionPresentation: new SessionPresentation(),
			renderSessionItems: vi.fn(),
		};
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof fakeThis,
			entries: SessionEntry[],
		) => void;

		renderSessionEntries.call(fakeThis, entries);

		expect(fakeThis.renderSessionItems).toHaveBeenCalledWith(
			[
				expect.objectContaining({ role: "compactionSummary", summary: "current summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: currentUsage },
				expect.objectContaining({ role: "compactionSummary", summary: "previous summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: previousUsage },
			],
			{},
		);
	});

	test("renders retained entries and appends the latest summary cost at the bottom", async () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const latestCompaction: SessionEntry = {
			type: "compaction",
			id: "latest",
			parentId: "previous",
			timestamp: "2025-01-02T00:00:00Z",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 123,
			usage,
		};
		const previousCompaction: SessionEntry = {
			type: "compaction",
			id: "previous",
			parentId: null,
			timestamp: "2025-01-01T00:00:00Z",
			summary: "previous summary",
			firstKeptEntryId: "kept",
			tokensBefore: 100,
			usage,
		};
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			refreshContextLine: vi.fn(),
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			sessionManager: { buildContextEntries: vi.fn().mockReturnValue([latestCompaction, previousCompaction]) },
			renderSessionEntries: vi.fn(),
			addMessageToChat: vi.fn(),
			addCompactionCostNotice: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string; usage?: Usage } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
				usage,
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith([previousCompaction]);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(fakeThis.addCompactionCostNotice).toHaveBeenCalledWith({
			type: "compaction_cost",
			kind: "compaction",
			usage,
		});
	});

	test("updates the working state when the same agent run resumes after compaction", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			refreshContextLine: vi.fn(),
			activeStatusIndicator: undefined,
			workingVisible: true,
			showWorkingStatusIndicator: vi.fn(),
			clearStatusIndicator: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => true },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "turn_start" },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.ui.terminal.setProgress).toHaveBeenCalledWith(true);
		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		fakeThis.workingVisible = false;
		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	// Regression test for #9340.
	test("routes interactive response aborts through AgentSession", () => {
		const abort = vi.fn(async () => {});
		const ui = {
			clearAllQueues: () => ({ steering: [], followUp: [] }),
			updatePendingMessagesDisplay: vi.fn(),
			session: { abort },
		};
		const restoreQueuedMessagesToEditor = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor") as (
			this: typeof ui,
			options?: { abort?: boolean },
		) => number;

		restoreQueuedMessagesToEditor.call(ui, { abort: true });

		expect(abort).toHaveBeenCalledOnce();
	});

	test("submits steering input to the session queue during compaction", async () => {
		const fakeThis = {
			editor: { addToHistory: vi.fn(), setText: vi.fn(), getText: vi.fn(() => "") },
			session: {
				prompt: vi.fn().mockResolvedValue(undefined),
			},
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
		};
		const queueCompactionMessage = Reflect.get(InteractiveMode.prototype, "queueCompactionMessage") as (
			this: typeof fakeThis,
			input: { text: string; images?: Array<{ type: "image"; data: string; mimeType: string }> },
			mode: "steer" | "followUp",
		) => void;
		const images = [{ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" }];
		queueCompactionMessage.call(fakeThis, { text: "change direction", images }, "steer");

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("change direction", {
			images,
			streamingBehavior: "steer",
		});
		expect(fakeThis.editor.setText).toHaveBeenCalledWith("");
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("submits slash-prefixed text as an ordinary queued message", async () => {
		const fakeThis = {
			editor: { addToHistory: vi.fn(), setText: vi.fn(), getText: vi.fn(() => "") },
			session: {
				prompt: vi.fn().mockResolvedValue(undefined),
			},
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
		};
		const queueCompactionMessage = Reflect.get(InteractiveMode.prototype, "queueCompactionMessage") as (
			this: typeof fakeThis,
			input: { text: string },
			mode: "steer" | "followUp",
		) => void;
		queueCompactionMessage.call(fakeThis, { text: "/compact" }, "followUp");

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("/compact", {
			images: undefined,
			streamingBehavior: "followUp",
		});
	});

	test("restores queued input text and binary attachments in queue order", () => {
		const steeringImages = [{ type: "image" as const, data: "c3RlZXI=", mimeType: "image/png" }];
		const followUpImages = [{ type: "image" as const, data: "Zm9sbG93", mimeType: "image/jpeg" }];
		const restoreImagesToEditor = vi.fn();
		const fakeThis = {
			clearAllQueues: () => ({
				steering: [{ text: "steer [Image #1 1×1]", images: steeringImages }],
				followUp: [{ text: "follow up [Image #2 2×2]", images: followUpImages }],
			}),
			editor: {
				getExpandedText: () => "draft",
				getText: () => "draft",
				setText: vi.fn(),
			},
			createEditorInput: () => ({ text: "draft", images: [] }),
			restoreImagesToEditor,
			updatePendingMessagesDisplay: vi.fn(),
			session: { abort: vi.fn() },
		};
		const restoreQueuedMessagesToEditor = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor") as (
			this: typeof fakeThis,
		) => number;

		expect(restoreQueuedMessagesToEditor.call(fakeThis)).toBe(2);
		expect(fakeThis.editor.setText).toHaveBeenCalledWith("steer\n\nfollow up\n\ndraft");
		expect(restoreImagesToEditor).toHaveBeenCalledWith([...steeringImages, ...followUpImages]);
	});

	test("captures binary image attachments before editor submission clears their markers", () => {
		const filePath = join(tmpdir(), `candy-input-${Date.now()}.png`);
		const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
		writeFileSync(filePath, Buffer.from(data, "base64"));
		try {
			const fakeThis = {
				editor: {
					getPastePaths: () => [filePath],
					getPromptText: () => "[Image #1 1×1]",
				},
			};
			const createEditorInput = Reflect.get(InteractiveMode.prototype, "createEditorInput") as (
				this: typeof fakeThis,
				text: string,
				imagePaths: string[],
				promptText: string,
			) => { text: string; images?: Array<{ type: "image"; data: string; mimeType: string }> };

			expect(createEditorInput.call(fakeThis, filePath, [filePath], "[Image #1 1×1]")).toEqual({
				text: "[Image #1 1×1]",
				images: [{ type: "image", data, mimeType: "image/png" }],
			});
		} finally {
			rmSync(filePath, { force: true });
		}
	});
});
