import * as bundledCandyAgentCore from "@candy/agent-core";
import * as bundledCandyAiCompat from "@candy/ai/compat";
import * as bundledCandyAiOauth from "@candy/ai/oauth";
import * as bundledCandyAiProviders from "@candy/ai/providers/all";
import * as bundledCandyTui from "@candy/tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @candy/coding-agent.
import * as bundledCandyCodingAgent from "../../index.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@candy/agent-core": bundledCandyAgentCore,
	"@candy/tui": bundledCandyTui,
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@candy/ai": bundledCandyAiCompat,
	"@candy/ai/compat": bundledCandyAiCompat,
	"@candy/ai/oauth": bundledCandyAiOauth,
	"@candy/ai/providers/all": bundledCandyAiProviders,
	"@candy/coding-agent": bundledCandyCodingAgent,
};
