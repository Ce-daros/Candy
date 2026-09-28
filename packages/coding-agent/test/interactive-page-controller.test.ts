import { Text } from "@candy/tui";
import { describe, expect, it } from "vitest";
import { InteractivePageController } from "../src/modes/interactive/interactive-page-controller.ts";

describe("InteractivePageController", () => {
	it("owns panel mount, focus, close animation, and stale close cancellation", () => {
		const events: string[] = [];
		let finishClose: (() => void) | undefined;
		const panel = new Text("panel", 0, 0);
		const editor = new Text("editor", 0, 0);
		const controller = new InteractivePageController({
			suspendPresentation: () => events.push("suspend"),
			closeTranscriptSearch: () => events.push("close-search"),
			mount: () => events.push("mount"),
			resumePresentation: () => false,
			focusEditor: () => events.push("focus-editor"),
			closeAnimation: (onComplete) => {
				events.push("close-animation");
				finishClose = onComplete;
			},
			restoreEditor: () => events.push("restore-editor"),
			requestRender: () => events.push("render"),
		});

		controller.mountPanel(panel);
		const generation = controller.generation;
		controller.closePanel();
		controller.mountPanel(editor);
		finishClose?.();

		expect(controller.generation).toBe(generation + 1);
		expect(events).toEqual([
			"suspend",
			"close-search",
			"mount",
			"render",
			"focus-editor",
			"close-animation",
			"suspend",
			"close-search",
			"mount",
			"render",
		]);
	});

	it("disposes selector resources before replacement and only closes the active selector", () => {
		const events: string[] = [];
		const component = new Text("selector", 0, 0);
		const controller = new InteractivePageController({
			suspendPresentation: () => {},
			closeTranscriptSearch: () => {},
			mount: () => {},
			resumePresentation: () => false,
			focusEditor: () => {},
			closeAnimation: (onComplete) => onComplete(),
			restoreEditor: () => events.push("restore"),
			requestRender: () => {},
		});

		controller.showSelector((_done) => ({ component, focus: component, dispose: () => events.push("dispose-1") }));
		controller.showSelector((_done) => ({ component, focus: component, dispose: () => events.push("dispose-2") }));
		expect(events).toEqual(["dispose-1"]);

		controller.disposeActiveSelector();
		expect(events).toEqual(["dispose-1", "dispose-2"]);
	});
});
