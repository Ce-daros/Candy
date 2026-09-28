import type { AgentSession } from "../core/agent-session.ts";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { exportSessionToHtml } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";

export async function exportSessionHtml(
	session: AgentSession,
	outputPath?: string,
	options: { themeName?: string } = {},
): Promise<string> {
	const themeName = [options.themeName, session.settingsManager.getTheme()].find(
		(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
	);
	const toolRenderer = createToolHtmlRenderer({
		getToolDefinition: (name) => session.getToolDefinition(name),
		theme,
		cwd: session.sessionManager.getCwd(),
	});
	return exportSessionToHtml(session.sessionManager, session.state, { outputPath, themeName, toolRenderer });
}
