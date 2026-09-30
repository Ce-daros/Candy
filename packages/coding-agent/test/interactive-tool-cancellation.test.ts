import type { TUI } from "@candy/tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createTui(): TUI {
	return { requestRender: vi.fn(), terminal: { rows: 30 } } as unknown as TUI;
}

describe("interactive tool cancellation", () => {
	beforeAll(() => initTheme("dark"));

	it.each([
		{ cancelled: true, status: "Cancelled", symbol: "⊘─", absent: "×─" },
		{ cancelled: false, status: "Tool failed", symbol: "×─", absent: "Cancelled" },
	])(
		"renders tool_execution_end cancelled=$cancelled distinctly from errors",
		async ({ cancelled, status, symbol, absent }) => {
			const ui = createTui();
			const component = new ToolExecutionComponent("custom_tool", "tool-1", {}, {}, undefined, ui, process.cwd());
			const context = {
				isInitialized: true,
				footer: { invalidate: vi.fn() },
				refreshContextLine: vi.fn(),
				pendingTools: new Map([["tool-1", component]]),
				renderer: ui,
			};
			const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
				this: typeof context,
				event: AgentSessionEvent,
			) => Promise<void>;
			await handleEvent.call(context, {
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "custom_tool",
				result: { content: [{ type: "text", text: status }] },
				isError: true,
				cancelled,
			});
			const rendered = stripAnsi(component.render(80).join("\n"));
			expect(rendered).toContain(symbol);
			expect(rendered).toContain(status);
			expect(rendered).not.toContain(absent);
			expect(context.pendingTools.size).toBe(0);
		},
	);

	it("restores persisted toolResult.cancelled in the transcript", () => {
		const ui = createTui();
		const addToolToChat = vi.fn<(component: ToolExecutionComponent) => void>();
		const context = {
			pendingTools: new Map<string, ToolExecutionComponent>(),
			settingsManager: {
				getShowCacheMissNotices: () => false,
				getShowImages: () => false,
				getImageWidthCells: () => 80,
				getToolPreviewLines: () => 5,
			},
			sessionManager: { getCwd: () => process.cwd() },
			session: { retryAttempt: 0 },
			toolOutputExpanded: false,
			getRegisteredToolDefinition: () => undefined,
			addMessageToChat: vi.fn(),
			addToolToChat,
			renderer: ui,
		};
		const renderSessionItems = Reflect.get(InteractiveMode.prototype, "renderSessionItems") as (
			this: typeof context,
			items: readonly unknown[],
		) => void;
		renderSessionItems.call(context, [
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "toolCall", id: "stored-tool", name: "custom_tool", arguments: {} }],
			},
			{
				role: "toolResult",
				toolCallId: "stored-tool",
				toolName: "custom_tool",
				content: [{ type: "text", text: "Interrupted" }],
				isError: true,
				cancelled: true,
			},
		]);
		const component = addToolToChat.mock.calls[0]?.[0];
		expect(component).toBeDefined();
		const rendered = stripAnsi(component!.render(80).join("\n"));
		expect(rendered).toContain("⊘─");
		expect(rendered).toContain("Cancelled");
	});
});
