import { APP_NAME } from "../config.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";

export function setupCli(): void {
	process.title = APP_NAME;
	process.env.CANDY_CODING_AGENT = "true";
	process.env.CANDY_AGENT = "candy";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	// Configure undici before provider SDKs issue requests. Settings are applied
	// once SettingsManager has loaded global/project configuration.
	configureHttpDispatcher();
}
