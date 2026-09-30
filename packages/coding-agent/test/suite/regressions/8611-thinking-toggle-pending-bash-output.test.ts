import { Container, type TUI } from "@candy/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

type UpdateThinkingBlockVisibility = (this: { chatContainer: Container; renderer: TUI }) => void;

type ToggleThinkingBlockVisibility = (this: {
	hideThinkingBlock: boolean;
	settingsManager: { commitSetting(scope: "global", field: "hideThinkingBlock", hidden: boolean): Promise<void> };
	updateThinkingBlockVisibility(): void;
	showStatus(message: string): void;
	showError(message: string): void;
}) => Promise<void>;

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("thinking visibility while a bash tool is running (#8611)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("preserves partial bash output", async () => {
		const renderer = { requestRender: vi.fn() } as unknown as TUI;
		const chatContainer = new Container();
		const component = new ToolExecutionComponent(
			"bash",
			"tool-8611",
			{ command: "echo first; sleep 10" },
			{ showImages: false },
			undefined,
			renderer,
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "first" }], isError: false }, true);
		chatContainer.addChild(component);

		const updateThinkingBlockVisibility = Reflect.get(
			InteractiveMode.prototype,
			"updateThinkingBlockVisibility",
		) as UpdateThinkingBlockVisibility;
		const toggleThinkingBlockVisibility = Reflect.get(
			InteractiveMode.prototype,
			"toggleThinkingBlockVisibility",
		) as ToggleThinkingBlockVisibility;
		const fakeThis = {
			hideThinkingBlock: false,
			settingsManager: { commitSetting: vi.fn(async () => {}) },
			chatContainer,
			renderer,
			updateThinkingBlockVisibility() {
				updateThinkingBlockVisibility.call(this);
			},
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		expect(renderChat(chatContainer)).toContain("first");
		await toggleThinkingBlockVisibility.call(fakeThis);

		expect(fakeThis.settingsManager.commitSetting).toHaveBeenCalledWith("global", "hideThinkingBlock", true);
		expect(chatContainer.children).toContain(component);
		expect(renderChat(chatContainer)).toContain("first");
	});
});
