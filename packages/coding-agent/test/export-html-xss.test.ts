import { describe, expect, it } from "vitest";
import { createTemplateRenderer } from "./export-html-template.ts";

describe("export HTML escaping", () => {
	it.each(["javascript:alert(1)", "vbscript:alert(1)", "data:text/html,attack", "java\u0000script:alert(1)"])(
		"rejects unsafe markdown link and image URLs: %s",
		(url) => {
			const renderer = createTemplateRenderer();
			for (const markdown of [`[click](<${url}>)`, `![image](<${url}>)`]) {
				expect(renderer.safeMarkedParse(markdown)).not.toMatch(/<(a|img)\b/);
			}
		},
	);

	it("preserves allowed URLs and escapes their attributes", () => {
		const renderer = createTemplateRenderer();
		for (const url of ["https://example.com", "mailto:me@example.com", "tel:123", "ftp://example.com", "/relative"]) {
			expect(renderer.safeMarkedParse(`[click](${url})`)).toContain(`href="${url}"`);
		}
		expect(renderer.safeMarkedParse('[click](<https://example.com/"onmouseover="attack>)')).toContain(
			'href="https://example.com/&quot;onmouseover=&quot;attack"',
		);
	});

	it("escapes image content and entry IDs before rendering attributes", () => {
		const attack = '" onerror="attack<>&';
		const html = createTemplateRenderer().renderEntry({
			id: attack,
			type: "message",
			message: { role: "user", content: [{ type: "image", mimeType: attack, data: attack }] },
		});
		expect(html).toContain('id="entry-&quot; onerror=&quot;attack&lt;&gt;&amp;"');
		expect(html).toContain('data-entry-id="&quot; onerror=&quot;attack&lt;&gt;&amp;"');
		expect(html).toContain(
			'src="data:&quot; onerror=&quot;attack&lt;&gt;&amp;;base64,&quot; onerror=&quot;attack&lt;&gt;&amp;"',
		);
		expect(html).not.toContain(attack);
	});

	it("escapes session metadata in the tree and header", () => {
		const attack = "<img src=x onerror=attack>";
		const renderer = createTemplateRenderer([
			{
				id: "assistant",
				type: "message",
				message: { role: "assistant", provider: attack, model: attack, content: [] },
			},
		]);
		for (const entry of [
			{ type: "message", message: { role: "toolResult", toolName: attack } },
			{ type: "message", message: { role: attack } },
			{ type: "model_change", modelId: attack },
			{ type: "thinking_level_change", thinkingLevel: attack },
			{ type: attack },
		]) {
			const html = renderer.getTreeNodeDisplayHtml(entry, attack);
			expect(html).toContain("&lt;img src=x onerror=attack&gt;");
			expect(html).not.toContain(attack);
		}
		expect(renderer.renderHeader()).toContain("&lt;img src=x onerror=attack&gt;");
		expect(renderer.renderHeader()).not.toContain(attack);
	});
});
