import type { ExtensionAPI } from "@candy/coding-agent";

export default function widgetPlacementExtension(candy: ExtensionAPI) {
	candy.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("widget-above", ["Above editor widget"]);
		ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
	});
}
