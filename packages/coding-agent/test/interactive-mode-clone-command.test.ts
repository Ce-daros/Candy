import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type CloneCommandContext = {
	runtimeHost: {
		clone: () => Promise<{ cancelled: boolean }>;
	};
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	renderer: { requestRender: () => void };
};

type InteractiveModePrototype = {
	handleCloneCommand(this: CloneCommandContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode History clone", () => {
	it("clones the current leaf into a new session", async () => {
		const clone = vi.fn(async () => ({ cancelled: false }));
		const setText = vi.fn();
		const showStatus = vi.fn();
		const showError = vi.fn();
		const requestRender = vi.fn();

		const context: CloneCommandContext = {
			runtimeHost: { clone },
			editor: { setText },
			showStatus,
			showError,
			renderer: { requestRender },
		};

		await interactiveModePrototype.handleCloneCommand.call(context);

		expect(clone).toHaveBeenCalledOnce();
		expect(setText).toHaveBeenCalledWith("");
		expect(showStatus).toHaveBeenCalledWith("Cloned to new session");
		expect(showError).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("shows a status message when there is nothing to clone", async () => {
		const clone = vi.fn(async () => {
			throw new Error("Nothing to clone yet");
		});
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: CloneCommandContext = {
			runtimeHost: { clone },
			editor: { setText: vi.fn() },
			showStatus,
			showError,
			renderer: { requestRender: vi.fn() },
		};

		await interactiveModePrototype.handleCloneCommand.call(context);

		expect(clone).toHaveBeenCalledOnce();
		expect(showStatus).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith("Nothing to clone yet");
	});

	it("does not clear the editor after clone cancellation", async () => {
		const requestRender = vi.fn();
		const setText = vi.fn();
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CloneCommandContext = {
			runtimeHost: { clone: vi.fn(async () => ({ cancelled: true })) },
			editor: { setText },
			showStatus,
			showError,
			renderer: { requestRender },
		};

		await interactiveModePrototype.handleCloneCommand.call(context);

		expect(setText).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalledOnce();
	});
});
