/**
 * Built-in tool renderers, without the tools themselves.
 *
 * A presentation displays tool calls and results; it does not execute them and does not need their
 * typebox parameter schemas. Importing this instead of `core/tools/index.ts` keeps ~17 MB of module
 * graph out of a process that only renders.
 */

import type { ToolName } from "../../core/tools/index.ts";
import type { ToolRenderers } from "../tool-render-types.ts";
import { createShellRenderers } from "./bash.ts";
import { codemodeRenderers } from "./codemode.ts";
import { editRenderers } from "./edit.ts";
import { findRenderers } from "./find.ts";
import { grepRenderers } from "./grep.ts";
import { lsRenderers } from "./ls.ts";
import { readRenderers } from "./read.ts";
import { writeRenderers } from "./write.ts";

export type { ToolRenderers } from "../tool-render-types.ts";

export {
	createShellRenderers,
	codemodeRenderers,
	editRenderers,
	findRenderers,
	grepRenderers,
	lsRenderers,
	readRenderers,
	writeRenderers,
};

const builtInToolRenderers: Record<ToolName, ToolRenderers> = {
	read: readRenderers,
	bash: createShellRenderers("$", "bash"),
	powershell: createShellRenderers("PS>", "powershell"),
	edit: editRenderers,
	write: writeRenderers,
	grep: grepRenderers,
	find: findRenderers,
	ls: lsRenderers,
};

export function getBuiltInToolRenderers(toolName: string): ToolRenderers | undefined {
	if (toolName === "codemode") return codemodeRenderers;
	return Object.hasOwn(builtInToolRenderers, toolName) ? builtInToolRenderers[toolName as ToolName] : undefined;
}
