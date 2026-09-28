import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

describe("RpcClient commands", () => {
	it("sends an explicit command identity and returns its disposition", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({ data: { disposition: "queued" } }));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => (response as { data: T }).data;

		const disposition = await client.executeCommand(
			{ source: "skill", name: "review", args: "src/app.ts" },
			"followUp",
		);

		expect(send).toHaveBeenCalledWith({
			type: "execute_command",
			source: "skill",
			name: "review",
			args: "src/app.ts",
			streamingBehavior: "followUp",
		});
		expect(disposition).toBe("queued");
	});
});
