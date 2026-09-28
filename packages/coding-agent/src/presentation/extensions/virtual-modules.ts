import * as bundledCandyAgentCore from "@candy/agent-core";
import * as bundledCandyAi from "@candy/ai";
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
export const extensionHostModules: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@candy/agent-core": bundledCandyAgentCore,
	"@candy/tui": bundledCandyTui,
	"@candy/ai": bundledCandyAi,
	"@candy/ai/oauth": bundledCandyAiOauth,
	"@candy/ai/providers/all": bundledCandyAiProviders,
	"@candy/coding-agent": bundledCandyCodingAgent,
};
