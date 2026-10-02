import type { AssistantMessage } from "@candy/ai";
import type { TuiMouseEvent } from "@candy/tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { TranscriptContainer } from "../src/modes/interactive/components/transcript-container.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	afterEach(() => vi.useRealTimers());

	test("ends each thinking run before the whole message finishes and links alternating blocks", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent();
		const message = createAssistantMessage([{ type: "thinking", thinking: "first" }]);
		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("✧");
		expect(stripAnsi(component.render(80).join("\n"))).toContain("│ first");
		component.updateContent(message, true, {
			type: "thinking_end",
			contentIndex: 0,
			content: "first",
			partial: message,
		});
		expect(stripAnsi(component.render(80).join("\n"))).toContain("▾");
		expect(stripAnsi(component.render(80).join("\n"))).toContain("│ first");
		message.content.push({ type: "text", text: "answer" }, { type: "thinking", thinking: "second" });
		component.updateContent(message, true);
		expect(
			component
				.render(80)
				.map(stripAnsi)
				.map((line) => line.trimEnd()),
		).toEqual(["", " ▾", " │ first", " │", " ✦ answer", " │", " ✧", " │ second"]);
		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("▾");
	});

	test("breathes while streaming and releases timers when completed or removed", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const component = new AssistantMessageComponent();
		component.setAnimationOptions(true, "moderate", vi.fn());
		const message = createAssistantMessage([{ type: "thinking", thinking: "checking" }]);
		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("✧");
		expect(stripAnsi(component.render(80).join("\n"))).toContain("│ checking");
		vi.advanceTimersByTime(600);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("✦");
		message.content.push({ type: "text", text: "done" });
		component.updateContent(message, true);
		const entering = component.render(80);
		vi.advanceTimersByTime(240);
		expect(component.render(80)).not.toEqual(entering);
		component.updateContent(message, false);
		expect(vi.getTimerCount()).toBe(0);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("✦ done");
		component.updateContent(message, true);
		const transcript = new TranscriptContainer();
		transcript.addChild(component);
		transcript.clear();
		expect(vi.getTimerCount()).toBe(0);
	});

	test("disabling animation settles the entrance and leaves a static active marker", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const component = new AssistantMessageComponent();
		component.setAnimationOptions(true, "moderate", vi.fn());
		component.updateContent(createAssistantMessage([{ type: "text", text: "streaming" }]), true);
		component.setAnimationOptions(false, "moderate", vi.fn());
		expect(vi.getTimerCount()).toBe(0);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("✧");
		expect(stripAnsi(component.render(80).join("\n"))).toContain("streaming");
	});

	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders length stops with neutral truncation wording", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], { stopReason: "length" }),
			true,
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("private reasoning");
		expect(rendered).toContain("Response was truncated before completion.");
	});

	test("coalesces adjacent thinking blocks and keeps three lines visible", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("first thought");
		expect(rendered).toContain("second thought");
		expect(rendered).not.toContain("▸");
		expect(rendered).toContain("answer");
	});

	test("folds thinking by rendered cell width, not raw line count", () => {
		initTheme("dark");
		// Four short lines: under the width budget, stays visible.
		const shortLines = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "one\ntwo\nthree\nfour" }]),
			true,
		);
		// One long unwrapped paragraph: folds even without newlines.
		const longParagraph = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "word ".repeat(60) }]),
			true,
		);
		// CJK chars occupy two cells: 120 chars = 240 cells stays visible, 121 folds.
		const cjkBoundary = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "思".repeat(120) }]),
			true,
		);
		const cjkOver = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: `思${"思".repeat(120)}` }]),
			true,
		);

		const shortRendered = stripAnsi(shortLines.render(80).join("\n"));
		expect(shortRendered).toContain("│ one");
		expect(shortRendered).not.toContain("▸");
		const folded = stripAnsi(longParagraph.render(80).join("\n"));
		expect(folded).toContain("▸");
		expect(folded).not.toContain("│ word");
		// The same text fits the line budget on a wider viewport, so it stays visible.
		const widened = stripAnsi(longParagraph.render(200).join("\n"));
		expect(widened).toContain("│ word");
		expect(widened).not.toContain("▸");
		expect(stripAnsi(cjkBoundary.render(80).join("\n"))).toContain("│ 思");
		expect(stripAnsi(cjkOver.render(80).join("\n"))).toContain("▸");
	});

	test("keeps a long folded thinking excerpt on one 80-column row", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: `${"reasoning ".repeat(20)}\n`.repeat(4) }]),
			true,
		);
		const lines = component.render(80).map(stripAnsi);
		const thinkingRows = lines.filter((line) => line.includes("▸"));
		expect(thinkingRows).toHaveLength(1);
		expect(thinkingRows[0].length).toBeLessThanOrEqual(80);
		expect(thinkingRows[0]).toContain("…");
	});

	test("folds the thinking marker after streaming finishes", () => {
		initTheme("dark");
		const message = createAssistantMessage([{ type: "thinking", thinking: "checking" }]);
		const component = new AssistantMessageComponent(undefined, true);
		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("✧");
		expect(stripAnsi(component.render(80).join("\n"))).toContain("│ checking");
		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("▾");
		expect(stripAnsi(component.render(80).join("\n"))).toContain("checking");
	});

	test("keeps prose near 110 columns while code uses the full terminal width", () => {
		initTheme("dark");
		const prose = "Candy visual language ".repeat(13).trim();
		const code = `const value = "${"x".repeat(120)}";`;
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: `${prose}\n\n\`\`\`ts\n${code}\n\`\`\`` }]),
		);
		const lines = component.render(160).map(stripAnsi);
		const proseLines = lines.filter((line) => line.includes("Candy visual language"));
		expect(proseLines.length).toBeGreaterThan(1);
		expect(proseLines.every((line) => line.trimEnd().length <= 113)).toBe(true);
		const codeLine = lines.find((line) => line.includes("const value"));
		expect(codeLine?.trimEnd().length).toBeGreaterThan(112);
		expect(codeLine?.trimEnd().length).toBeLessThanOrEqual(160);
	});

	test("marks a closed streamed code fence complete before the message finishes", () => {
		initTheme("dark");
		const completions: boolean[] = [];
		const component = new AssistantMessageComponent(
			undefined,
			true,
			undefined,
			"Thinking...",
			1,
			(_code, _language, _width, _streaming, complete) => {
				completions.push(complete);
				return undefined;
			},
		);
		component.updateContent(
			createAssistantMessage([{ type: "text", text: "```mermaid\nflowchart LR\n  A --> B" }]),
			true,
		);
		component.render(100);
		component.updateContent(
			createAssistantMessage([{ type: "text", text: "```mermaid\nflowchart LR\n  A --> B\n```" }]),
			true,
		);
		component.render(100);
		expect(completions).toEqual([false, true]);
	});

	test("expands one thinking run without opening its neighbor", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: Array(8).fill("first reasoning stretches past the fold budget").join("\n") },
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: Array(8).fill("second reasoning stretches past the fold budget").join("\n") },
			]),
		);
		const width = 80;
		const lines = component.render(width);
		const firstThinkingRow = lines.findIndex((line) => stripAnsi(line).includes("first reasoning"));
		expect(firstThinkingRow).toBeGreaterThanOrEqual(0);
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 1,
			y: firstThinkingRow,
			screenX: 1,
			screenY: firstThinkingRow,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(component.handleMouse(event)?.handled).toBe(true);

		const expanded = stripAnsi(component.render(width).join("\n"));
		expect(expanded).toContain("│ first reasoning");
		expect(expanded).toContain("▸ second reasoning");
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes(" hello"))).toBe(true);
		expect(lines.some((line) => line.includes(" reasoning"))).toBe(true);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		expect(updatedLines.some((line) => line.startsWith("✦ hello"))).toBe(true);
		expect(updatedLines.some((line) => /│\s+reasoning/.test(line))).toBe(true);
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.includes(" ◆ hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.includes("◆ hello"))).toBe(true);
	});
});
