import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import reloadRuntimeExtension from "./fixtures/reload-runtime.ts";

describe("reload-runtime example extension", () => {
	it("reloads from Command and does not send a slash message from its tool", async () => {
		const registerCommand = vi.fn();
		const registerTool = vi.fn();
		const sendUserMessage = vi.fn();
		reloadRuntimeExtension({ registerCommand, registerTool, sendUserMessage } as unknown as ExtensionAPI);

		const command = registerCommand.mock.calls[0]?.[1] as {
			handler: (_args: string, ctx: { reload: () => Promise<void> }) => Promise<void>;
		};
		const reload = vi.fn(async () => {});
		await command.handler("", { reload });
		expect(reload).toHaveBeenCalledOnce();

		const tool = registerTool.mock.calls[0]?.[0] as {
			execute: () => Promise<{ isError: boolean; content: Array<{ type: string; text: string }> }>;
		};
		const result = await tool.execute();
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Choose reload-runtime in Command");
		expect(sendUserMessage).not.toHaveBeenCalled();
	});
});
