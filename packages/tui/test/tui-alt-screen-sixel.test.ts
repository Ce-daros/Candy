import assert from "node:assert";
import { it } from "node:test";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

it("replays Sixel images after unchanged, text, and resize renders", async () => {
	setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
	const terminal = new RecordingTerminal(20, 5);
	const tui = new TuiAltScreen(terminal);
	const image = "\x1bPq~\x1b\\";
	let footer = "footer";
	tui.setLayoutRoot({ render: () => ["header", image, "", footer], invalidate: () => {} });
	try {
		tui.start();
		await terminal.waitForRender();
		assert.ok(terminal.writes.join("").includes(image));

		terminal.writes.length = 0;
		tui.requestRender();
		await terminal.waitForRender();
		assert.ok(terminal.writes.join("").includes(image));

		terminal.writes.length = 0;
		footer = "edited";
		tui.requestRender();
		await terminal.waitForRender();
		const textUpdate = terminal.writes.join("");
		assert.ok(textUpdate.includes("edited"));
		assert.ok(textUpdate.includes(image));
		assert.ok(textUpdate.indexOf("edited") < textUpdate.indexOf(image));
		assert.ok(!textUpdate.includes("\x1b[2J"));

		terminal.writes.length = 0;
		terminal.resize(21, 5);
		await terminal.waitForRender();
		assert.ok(terminal.writes.join("").includes(image));
	} finally {
		tui.stop();
		resetCapabilitiesCache();
	}
});
