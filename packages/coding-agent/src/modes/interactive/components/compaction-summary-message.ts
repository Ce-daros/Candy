import type { MarkdownTheme } from "@candy/tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme } from "../theme/theme.ts";
import { TranscriptDisclosure } from "./transcript-disclosure.ts";

export class CompactionSummaryMessageComponent extends TranscriptDisclosure {
	constructor(message: CompactionSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(
			"Compaction",
			`${message.tokensBefore.toLocaleString()} tokens before`,
			message.summary,
			markdownTheme,
			"rule",
		);
	}
}
