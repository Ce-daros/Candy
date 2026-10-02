import { describe, expect, it, vi } from "vitest";
import promptUrlWidgetExtension from "../../../.candy/extensions/prompt-url-widget.ts";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import { createHarness } from "./suite/harness.ts";

const prUrl = "https://github.com/Ce-daros/Candy/pull/123";

async function setup() {
	const exec = vi.fn(async () => ({
		stdout: JSON.stringify({ title: "Fix logo", author: { login: "author" } }),
		stderr: "",
		code: 0,
		killed: false,
	}));
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.exec = exec;
				promptUrlWidgetExtension(pi);
			},
		],
	});
	const setWidget = vi.fn<ExtensionUIContext["setWidget"]>();
	const uiContext: ExtensionUIContext = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		notify: vi.fn(),
		setStatus: vi.fn(),
		setWidget,
	};
	const bind = () => harness.session.execution.bindExtensions({ uiContext, mode: "tui" });
	return { harness, exec, setWidget, bind };
}

describe("project prompt URL widget", () => {
	it("starts an empty session without accessing removed context APIs", async () => {
		const { harness, exec, setWidget, bind } = await setup();
		try {
			await bind();
			expect(setWidget).toHaveBeenCalledWith("prompt-url", undefined);
			expect(exec).not.toHaveBeenCalled();
		} finally {
			await harness.cleanup();
		}
	});

	it("restores a PR widget with plain text and waits for metadata", async () => {
		const { harness, exec, setWidget, bind } = await setup();
		try {
			harness.sessionManager.appendMessage({
				role: "user",
				content: `You are given one or more GitHub PR URLs: ${prUrl}`,
				timestamp: Date.now(),
			});
			await bind();
			expect(setWidget).toHaveBeenNthCalledWith(1, "prompt-url", [prUrl]);
			expect(setWidget).toHaveBeenLastCalledWith("prompt-url", ["Fix logo", "@author", prUrl]);
			expect(exec).toHaveBeenCalledWith("gh", ["pr", "view", prUrl, "--json", "title,author"]);
		} finally {
			await harness.cleanup();
		}
	});

	it("ignores matching prompts on another session branch", async () => {
		const { harness, exec, setWidget, bind } = await setup();
		try {
			const root = harness.sessionManager.appendMessage({
				role: "user",
				content: "Hello",
				timestamp: Date.now(),
			});
			harness.sessionManager.appendMessage({
				role: "user",
				content: `You are given one or more GitHub PR URLs: ${prUrl}`,
				timestamp: Date.now(),
			});
			harness.sessionManager.branch(root);
			await bind();
			expect(setWidget).toHaveBeenCalledWith("prompt-url", undefined);
			expect(exec).not.toHaveBeenCalled();
		} finally {
			await harness.cleanup();
		}
	});
});
