import type { AgentSession } from "../core/agent-session.ts";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { exportSessionToHtml } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import { getBuiltInToolRenderers } from "./tool-renderers/index.ts";

export async function exportSessionHtml(
	session: AgentSession,
	outputPath?: string,
	options: { themeName?: string } = {},
): Promise<string> {
	const themeName = [options.themeName, session.execution.settingsManager.getTheme()].find(
		(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
	);
	const toolRenderer = createToolHtmlRenderer({
		getToolDefinition: getBuiltInToolRenderers,
		theme,
		cwd: session.history.getCwd(),
	});
	return exportSessionToHtml(session.history, session.execution.state, { outputPath, themeName, toolRenderer });
}
