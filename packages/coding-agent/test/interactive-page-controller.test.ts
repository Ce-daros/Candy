import { Text } from "@candy/tui";
import { describe, expect, it } from "vitest";
import { type InteractiveFlowFrame, InteractiveFlowStack } from "../src/modes/interactive/interactive-flow-stack.ts";
import { InteractivePageController } from "../src/modes/interactive/interactive-page-controller.ts";

function createController(flows: InteractiveFlowStack, events: string[]) {
	let finishClose: (() => void) | undefined;
	const controller = new InteractivePageController(
		{
			closeTranscriptSearch: () => events.push("close-search"),
			mount: () => events.push("mount"),
			focusEditor: () => events.push("focus-editor"),
			closeAnimation: (onComplete) => {
				events.push("close-animation");
				finishClose = onComplete;
			},
			restoreEditor: () => events.push("restore-editor"),
			requestRender: () => events.push("render"),
		},
		flows,
	);
	return { controller, finishClose: () => finishClose?.() };
}

function frame(
	content = new Text("presentation", 0, 0),
	events: string[] = [],
): Omit<InteractiveFlowFrame, "controller"> {
	return {
		role: "presentation",
		kind: "history",
		content,
		onSuspend: () => events.push("suspend-parent"),
		onResume: () => events.push("resume-parent"),
	};
}

describe("InteractivePageController", () => {
	it("invalidates stale close animations when a new flow opens", () => {
		const events: string[] = [];
		const flows = new InteractiveFlowStack();
		const { controller, finishClose } = createController(flows, events);

		controller.mountPanel(new Text("old panel", 0, 0));
		controller.closePanel();
		controller.mountPanel(new Text("new panel", 0, 0));
		finishClose();

		expect(events).not.toContain("restore-editor");
	});

	it("disposes replaced selectors and ignores their stale completion callbacks", () => {
		const events: string[] = [];
		const flows = new InteractiveFlowStack();
		const { controller } = createController(flows, events);
		const component = new Text("selector", 0, 0);
		let completeFirst!: () => void;
		let completeSecond!: () => void;

		controller.showSelector((done) => {
			completeFirst = done;
			return { component, focus: component, dispose: () => events.push("dispose-first") };
		});
		controller.showSelector((done) => {
			completeSecond = done;
			return { component, focus: component, dispose: () => events.push("dispose-second") };
		});
		const active = flows.current;

		expect(events).not.toContain("resume-parent");
		expect(events).toContain("dispose-first");
		completeFirst();
		expect(flows.current).toBe(active);
		completeSecond();
		expect(flows.current).toBeUndefined();
		expect(events).toContain("dispose-second");
	});

	it("aborts selector work and resumes its page when the selector is cancelled", () => {
		const events: string[] = [];
		const flows = new InteractiveFlowStack();
		const parent = flows.push(frame(new Text("history", 0, 0), events));
		const { controller } = createController(flows, events);
		let cancel!: () => void;
		controller.showSelector((done) => {
			cancel = done;
			return {
				component: new Text("selector", 0, 0),
				focus: new Text("focus", 0, 0),
				dispose: () => events.push("dispose-selector"),
			};
		});
		const signal = flows.current!.controller.signal;
		signal.addEventListener("abort", () => events.push("cancel-async-work"));

		cancel();

		expect(signal.aborted).toBe(true);
		expect(flows.current).toBe(parent);
		expect(events).toEqual([
			"suspend-parent",
			"close-search",
			"mount",
			"render",
			"cancel-async-work",
			"dispose-selector",
			"resume-parent",
		]);
	});

	it("aborts and disposes the whole flow stack on invalidation", () => {
		const events: string[] = [];
		const flows = new InteractiveFlowStack();
		const parent = flows.push(frame(new Text("history", 0, 0), events));
		const { controller } = createController(flows, events);
		controller.showSelector((_done) => {
			const component = new Text("selector", 0, 0);
			return { component, focus: component, dispose: () => events.push("dispose-selector") };
		});
		const selectorSignal = flows.current?.controller.signal;

		controller.invalidateFlows();
		expect(flows.current).toBeUndefined();
		expect(parent.controller.signal.aborted).toBe(true);
		expect(selectorSignal?.aborted).toBe(true);
		expect(events).toContain("dispose-selector");
		expect(events).not.toContain("resume-parent");
	});
});
