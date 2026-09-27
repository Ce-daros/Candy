import type { MarkdownTheme } from "@candy/tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import { getMarkdownTheme } from "../theme/theme.ts";
import { TranscriptDisclosure } from "./transcript-disclosure.ts";

export class SkillInvocationMessageComponent extends TranscriptDisclosure {
	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(`Skill ${skillBlock.name}`, "", skillBlock.content, markdownTheme, "skill", skillBlock.location);
	}
}
