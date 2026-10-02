import * as bundledCandyAgentCore from "@candy/agent-core";
import * as bundledCandyAi from "@candy/ai";
import * as bundledCandyAiProviders from "@candy/ai/providers/all";
import * as bundledCandyTui from "@candy/tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
import * as bundledCandyCodingAgent from "../../index.ts";
import * as bundledCandyCodingAgentRpc from "../../rpc.ts";
import * as bundledCandyCodingAgentUi from "../../ui.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const extensionHostModules: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@candy/agent-core": bundledCandyAgentCore,
	"@candy/tui": bundledCandyTui,
	"@candy/ai": bundledCandyAi,
	"@candy/ai/providers/all": bundledCandyAiProviders,
	"@candy/coding-agent": bundledCandyCodingAgent,
	"@candy/coding-agent/ui": bundledCandyCodingAgentUi,
	"@candy/coding-agent/rpc": bundledCandyCodingAgentRpc,
};
