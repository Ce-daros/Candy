import { visibleWidth } from "@candy/tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createSession(options: {
	modelId?: string;
	modelName?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
}): AgentSession {
	return {
		selection: {
			model: {
				id: options.modelId ?? "test-model",
				name: options.modelName,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
	} as AgentSession;
}

function renderStatus(session: AgentSession, width: number, hiddenLineCount = 0): string {
	return stripAnsi(new FooterComponent(session).renderBottomBorder(width, hiddenLineCount, (text) => text));
}

describe("FooterComponent bottom border", () => {
	beforeAll(() => initTheme(undefined, false));

	it("fills exactly the requested width for every terminal size", () => {
		const session = createSession({ modelName: "Kimi K2.6", reasoning: true });
		for (const width of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 20, 40, 60, 93, 200]) {
			expect(visibleWidth(renderStatus(session, width)), `width ${width}`).toBe(width);
		}
	});

	it("keeps a long model within the border", () => {
		const session = createSession({ modelId: "模".repeat(30), reasoning: true });
		expect(visibleWidth(renderStatus(session, 60))).toBe(60);
	});

	it("shows thinking only for reasoning models", () => {
		expect(renderStatus(createSession({ reasoning: true, thinkingLevel: "medium" }), 80)).toContain("Medium");
		expect(renderStatus(createSession({ reasoning: false, thinkingLevel: "medium" }), 80)).not.toContain("Medium");
	});

	it("paints the model label in the accent color without a chevron", () => {
		const line = new FooterComponent(createSession({})).renderBottomBorder(60, 0, (text) => text);
		expect(line).toContain(theme.getFgAnsi("accent"));
		expect(stripAnsi(line)).not.toContain("▾");
	});

	it("includes the hidden-line count when the editor scrolled", () => {
		expect(renderStatus(createSession({}), 80, 3)).toContain("↓ 3 more");
	});
});
