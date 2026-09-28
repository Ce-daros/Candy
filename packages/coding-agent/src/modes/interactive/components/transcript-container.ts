import { type Component, Container } from "@candy/tui";
import { AssistantMessageComponent } from "./assistant-message.ts";

export class TranscriptContainer extends Container {
	override removeChild(component: Component): void {
		if (component instanceof AssistantMessageComponent) component.dispose();
		super.removeChild(component);
	}

	dispose(): void {
		for (const child of this.children) {
			if (child instanceof AssistantMessageComponent) child.dispose();
		}
	}

	override clear(): void {
		this.dispose();
		super.clear();
	}
}
