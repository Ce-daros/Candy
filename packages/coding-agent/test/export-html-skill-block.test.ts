import { describe, expect, it } from "vitest";
import { createTemplateRenderer } from "./export-html-template.ts";

describe("export HTML skill blocks", () => {
	it("renders the skill markdown and user prompt as separate blocks", () => {
		const entry = {
			id: "skill",
			type: "message",
			message: {
				role: "user",
				content:
					'<skill name="review" location="/skills/review/SKILL.md">\n**Review rules**\n</skill>\n\nCheck this change',
			},
		};
		const renderer = createTemplateRenderer();
		const html = renderer.renderEntry(entry);
		expect(html).toContain("<strong>Review rules</strong>");
		expect(html).toMatch(/<\/div>\s*<\/div><div class="user-message">/);
		expect(html).toContain("Check this change");
		expect(html).not.toContain("&lt;skill");
		const tree = renderer.getTreeNodeDisplayHtml(entry);
		expect(tree).toContain("review");
		expect(tree).toContain("Check this change");
	});

	it("omits an empty user prompt but retains attached images", () => {
		const content = '<skill name="review" location="/skills/review/SKILL.md">\nRules\n</skill>';
		const renderer = createTemplateRenderer();
		const entry = { id: "skill", type: "message", message: { role: "user", content } };
		expect(renderer.renderEntry(entry)).not.toContain('class="user-message"');
		expect(
			renderer.renderEntry({
				...entry,
				message: {
					role: "user",
					content: [
						{ type: "text", text: content },
						{ type: "image", mimeType: "image/png", data: "aGk=" },
					],
				},
			}),
		).toContain('src="data:image/png;base64,aGk="');
	});
});
