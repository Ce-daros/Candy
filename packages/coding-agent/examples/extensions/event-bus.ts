/**
 * Inter-extension event bus example.
 *
 * Shows candy.events for communication between extensions. One extension
 * can emit events that other extensions listen to.
 *
 * Usage: open Command and choose `emit`, then enter the event name and data.
 */

import type { ExtensionAPI, ExtensionContext } from "@candy/coding-agent";

export default function (candy: ExtensionAPI) {
	// Store ctx for use in event handler
	let currentCtx: ExtensionContext | undefined;

	candy.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
	});

	// Listen for events from other extensions
	candy.events.on("my:notification", (data) => {
		const { message, from } = data as { message: string; from: string };
		currentCtx?.ui.notify(`Event from ${from}: ${message}`, "info");
	});

	// Command to emit events (emits "my:notification" which the listener above receives)
	candy.registerCommand("emit", {
		description: "Emit a notification event",
		handler: async (args, _ctx) => {
			const message = args.trim() || "hello";
			candy.events.emit("my:notification", { message, from: "emit command" });
			// Listener above will show the notification
		},
	});

	// Example: emit on session start
	candy.on("session_start", async () => {
		candy.events.emit("my:notification", {
			message: "Session started",
			from: "event-bus-example",
		});
	});
}
