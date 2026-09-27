import { visibleWidth } from "@candy/tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createSession(options: {
	modelId?: string;
	modelName?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
}): AgentSession {
	return {
		state: {
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

	it("shows model and thinking level without context usage", () => {
		const session = createSession({ modelName: "Kimi K2.6", reasoning: true, thinkingLevel: "medium" });
		const line = renderStatus(session, 60);
		expect(line).toContain("Kimi K2.6 ▾ ─ Medium ▾");
		expect(line).toMatch(/^╰── .*─╯$/);
		expect(line).not.toMatch(/\d+%|━|┄|╾|Context/);
	});

	it("keeps a long model within the border", () => {
		const session = createSession({ modelId: "模".repeat(30), reasoning: true });
		expect(visibleWidth(renderStatus(session, 60))).toBe(60);
	});

	it("shows the model name without its vendor prefix", () => {
		const session = createSession({ modelId: "moonshotai/kimi-k2.6", modelName: "MoonshotAI: Kimi K2.6" });
		const line = renderStatus(session, 80);
		expect(line).toContain("Kimi K2.6");
		expect(line).not.toContain("MoonshotAI");
	});

	it("falls back to the final id segment when the model has no name", () => {
		const line = renderStatus(createSession({ modelId: "moonshotai/kimi-k2.6" }), 80);
		expect(line).toContain("kimi-k2.6");
		expect(line).not.toContain("moonshotai/");
	});

	it("shows thinking only for reasoning models", () => {
		expect(renderStatus(createSession({ reasoning: true, thinkingLevel: "medium" }), 80)).toContain("Medium ▾");
		expect(renderStatus(createSession({ reasoning: false, thinkingLevel: "medium" }), 80)).not.toContain("Medium ▾");
	});

	it("drops the effort selector before truncating the model", () => {
		const session = createSession({ modelName: "Kimi K2.6", reasoning: true, thinkingLevel: "medium" });
		expect(renderStatus(session, 20)).toBe("╰── Kimi K2.6 ▾ ───╯");
	});

	it("includes the hidden-line count when the editor scrolled", () => {
		expect(renderStatus(createSession({}), 80, 3)).toContain("↓ 3 more");
	});
});
