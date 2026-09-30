import { APP_NAME } from "../config.ts";

export function setupCli(): void {
	process.title = APP_NAME;
	process.env.CANDY_CODING_AGENT = "true";
	process.env.CANDY_AGENT = "candy";
	process.emitWarning = (() => {}) as typeof process.emitWarning;
}
