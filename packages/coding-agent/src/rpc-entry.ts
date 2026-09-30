#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
process.env.CANDY_CODING_AGENT = "true";
process.env.CANDY_AGENT = "candy";
process.emitWarning = (() => {}) as typeof process.emitWarning;

await main(["--mode", "rpc", ...process.argv.slice(2)]);
