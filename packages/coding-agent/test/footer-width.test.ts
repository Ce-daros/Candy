import { visibleWidth } from "@candy/tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createSession(options: {
	modelId?: string;
	modelName?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	contextPercent?: number | null;
	contextWindow?: number;
}): AgentSession {
	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				name: options.modelName,
				provider: options.provider ?? "test",
				contextWindow: options.contextWindow ?? 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		getContextUsage: () => ({
			contextWindow: options.contextWindow ?? 200_000,
			percent: options.contextPercent === undefined ? 12.3 : options.contextPercent,
		}),
	};

	return session as unknown as AgentSession;
}

/** Render the merged bottom border with an uncolored frame so assertions stay readable. */
function renderStatus(
	session: AgentSession,
	options: { width?: number; hiddenLineCount?: number; pendingTokens?: number } = {},
): string {
	const footer = new FooterComponent(session);
	if (options.pendingTokens !== undefined) footer.setPendingTokens(options.pendingTokens);
	const width = options.width ?? 120;
	return stripAnsi(footer.renderBottomBorder(width, options.hiddenLineCount ?? 0, (text) => text));
}

describe("FooterComponent bottom border", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("fills exactly the requested width for every terminal size", () => {
		const session = createSession({ modelId: "kimi-k2.6", modelName: "Kimi K2.6", reasoning: true });

		for (const width of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 20, 40, 60, 93, 200]) {
			const line = renderStatus(session, { width, pendingTokens: 38000 });
			expect(visibleWidth(line), `width ${width}`).toBe(width);
		}
	});

	it("keeps the frame within width for wide model names", () => {
		const width = 60;
		const session = createSession({ modelId: "模".repeat(30), reasoning: true, thinkingLevel: "high" });

		expect(visibleWidth(renderStatus(session, { width }))).toBe(width);
	});

	it("shows the model name without the vendor prefix", () => {
		const prefixed = createSession({ modelId: "moonshotai/kimi-k2.6", modelName: "MoonshotAI: Kimi K2.6" });
		const line = renderStatus(prefixed);

		expect(line).toContain("Kimi K2.6");
		expect(line).not.toContain("MoonshotAI");
		expect(line).not.toContain("moonshotai");
	});

	it("keeps a model name that has no vendor prefix unchanged", () => {
		const session = createSession({ modelId: "moonshotai/Kimi-K2-Instruct", modelName: "Kimi-K2-Instruct" });

		expect(renderStatus(session)).toContain("Kimi-K2-Instruct");
	});

	it("falls back to the id when the model has no name", () => {
		const session = createSession({ modelId: "moonshotai/kimi-k2.6" });

		const line = renderStatus(session);
		expect(line).toContain("kimi-k2.6");
		expect(line).not.toContain("moonshotai/");
	});

	it("shows the thinking level only for reasoning models", () => {
		expect(renderStatus(createSession({ reasoning: true, thinkingLevel: "medium" }))).toContain("Medium ▾");
		expect(renderStatus(createSession({ reasoning: false, thinkingLevel: "medium" }))).not.toContain("medium");
	});

	it("always shows the percentage with the meter mapped to the context ratio", () => {
		const session = createSession({
			modelId: "kimi-k2.6",
			modelName: "Kimi K2.6",
			reasoning: true,
			thinkingLevel: "medium",
			contextPercent: 42,
		});
		const line = renderStatus(session, { width: 80 });

		// labels 22 + corner 4 + separator 2 + right border 1 => meter 51.
		// one frontier + " 42% " (5) leaves 45 track cells, 19 filled.
		expect(line).toBe(`╰── Kimi K2.6 ▾   Medium ▾ ─${"━".repeat(19)} 42% ╾${"─".repeat(26)}╯`);
	});

	it("scales the meter to the remaining border width regardless of label length", () => {
		for (const modelName of ["Kimi K2.6", "An exceptionally long model name with many words"]) {
			const session = createSession({ modelId: "model", modelName, contextPercent: 42 });
			const line = renderStatus(session, { width: 100 });
			const meter = line.slice(line.indexOf(" ▾ ─") + " ▾ ─".length, -1);
			const trackWidth = meter.length - 1 - " 42% ".length;
			const filled = Math.round(trackWidth * 0.42);
			expect(meter).toBe(`${"━".repeat(filled)} 42% ╾${"─".repeat(trackWidth - filled)}`);
		}
	});

	it("keeps both percentages visible while the composer has pending text", () => {
		const session = createSession({ modelId: "model", modelName: "Kimi K2.6", contextPercent: 42 });
		const footer = new FooterComponent(session);
		footer.setPendingTokens(38000);
		const line = stripAnsi(footer.renderBottomBorder(80, 0, (text) => text));

		expect(line).toContain(" 42% ╾");
		expect(line).toContain(" 61% ╾");
	});

	it("suppresses the projected segment when it cannot advance the displayed percentage", () => {
		const session = createSession({ modelId: "model", modelName: "Kimi K2.6", contextPercent: 42 });
		const line = renderStatus(session, { width: 80, pendingTokens: 1 });

		expect(line).not.toContain("┄");
		expect(line).toContain(" 42% ╾");
	});

	it("keeps the pending frontier when the rounded projection is 100 but space remains", () => {
		const session = createSession({ modelId: "model", modelName: "Kimi K2.6", contextPercent: 42 });
		const line = renderStatus(session, { width: 120, pendingTokens: 115000 });
		expect(line).toContain(" 100% ╾");
	});

	it("keeps the frame color around colored selector labels", () => {
		const session = createSession({ modelId: "model", modelName: "Kimi K2.6", contextPercent: 42 });
		const footer = new FooterComponent(session);
		const line = footer.renderBottomBorder(80, 0, (text) => `<border>${text}</border>`);
		expect(line).toContain("<border>╰── </border>Kimi K2.6");
		expect(line).toContain("<border> ─</border>");
		expect(line).toContain("<border>╯</border>");
	});

	it("keeps the percentage inside the meter at high usage", () => {
		const session = createSession({
			modelId: "kimi-k2.6",
			modelName: "Kimi K2.6",
			reasoning: true,
			thinkingLevel: "medium",
			contextPercent: 91,
		});
		const line = renderStatus(session, { width: 80 });

		expect(line).toBe(`╰── Kimi K2.6 ▾   Medium ▾ ─${"━".repeat(41)} 91% ╾${"─".repeat(4)}╯`);
	});

	it("renders pending context as a dashed segment with both frontiers", () => {
		const session = createSession({
			modelId: "kimi-k2.6",
			modelName: "Kimi K2.6",
			reasoning: true,
			thinkingLevel: "medium",
			contextPercent: 42,
		});
		// 38000 / 200000 => +19 points, projecting 61%.
		const line = renderStatus(session, { width: 80, pendingTokens: 38000 });

		expect(line).toBe(`╰── Kimi K2.6 ▾   Medium ▾ ─${"━".repeat(16)} 42% ╾${"┄".repeat(8)} 61% ╾${"─".repeat(15)}╯`);
	});

	it("omits the pending frontier when the projection reaches the right border", () => {
		const session = createSession({
			modelId: "kimi-k2.6",
			modelName: "Kimi K2.6",
			reasoning: true,
			thinkingLevel: "medium",
			contextPercent: 42,
		});
		// 116000 / 200000 => +58 points, projecting 100%.
		const line = renderStatus(session, { width: 80, pendingTokens: 116000 });

		expect(line).toBe(`╰── Kimi K2.6 ▾   Medium ▾ ─${"━".repeat(16)} 42% ╾${"┄".repeat(23)} 100% ╯`);
	});

	it("shows an unfilled meter when context usage is unknown", () => {
		const session = createSession({ modelId: "kimi-k2.6", modelName: "Kimi K2.6", contextPercent: null });
		const line = renderStatus(session, { width: 80, pendingTokens: 38000 });

		expect(line).toContain("╰── Kimi K2.6 ▾ ─");
		expect(line).not.toContain("╾");
		expect(line).not.toContain("━");
		expect(line).not.toContain("┄");
	});

	it("drops the meter instead of breaking the frame when the terminal is narrow", () => {
		const session = createSession({
			modelId: "kimi-k2.6",
			modelName: "Kimi K2.6",
			reasoning: true,
			thinkingLevel: "medium",
			contextPercent: 42,
		});
		const line = renderStatus(session, { width: 30 });

		expect(line).toBe("╰── Kimi K2.6 ▾   Medium ▾ ──╯");
		expect(visibleWidth(line)).toBe(30);
	});

	it("drops the effort selector before truncating the model", () => {
		const session = createSession({
			modelId: "kimi-k2.6",
			modelName: "Kimi K2.6",
			reasoning: true,
			thinkingLevel: "medium",
			contextPercent: 42,
		});
		const line = renderStatus(session, { width: 20 });

		expect(line).toBe("╰── Kimi K2.6 ▾ ───╯");
		expect(visibleWidth(line)).toBe(20);
	});

	it("includes the hidden-line count when the editor scrolled", () => {
		const line = renderStatus(createSession({}), { hiddenLineCount: 3 });

		expect(line).toContain("↓ 3 more");
	});
});
