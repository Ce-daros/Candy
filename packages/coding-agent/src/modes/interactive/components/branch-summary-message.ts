import type { MarkdownTheme } from "@candy/tui";
import type { BranchSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme } from "../theme/theme.ts";
import { TranscriptDisclosure } from "./transcript-disclosure.ts";

export class BranchSummaryMessageComponent extends TranscriptDisclosure {
	constructor(message: BranchSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super("Branch summary", "", message.summary, markdownTheme, "rule");
	}
}
