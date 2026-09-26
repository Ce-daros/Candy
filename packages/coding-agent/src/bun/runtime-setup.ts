import { bedrockProviderModule } from "@candy/ai/bedrock-provider";
import { registerBunOAuthFlows } from "@candy/ai/bun-oauth";
import { setBedrockProviderModule } from "@candy/ai/compat";
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
