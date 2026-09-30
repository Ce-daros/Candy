import type { KeybindingsConfig, KeybindingsManager as TuiKeybindingsManager } from "@candy/tui";

export type { KeybindingsConfig } from "@candy/tui";
export interface AppKeybindings {
	"app.interrupt": true;
	"app.clear": true;
	"app.exit": true;
	"app.suspend": true;
	"app.command.enter": true;
	"app.help.enter": true;
	"app.reload": true;
	"app.command.arguments": true;
	"app.shell.enter": true;
	"app.powerbar.left": true;
	"app.powerbar.right": true;
	"app.powerbar.next": true;
	"app.powerbar.up": true;
	"app.powerbar.down": true;
	"app.panel.focusNext": true;
	"app.panel.focusPrevious": true;
	"app.panel.scope": true;
	"app.settings.reset": true;
	"app.settings.previous": true;
	"app.settings.next": true;
	"app.model.select": true;
	"app.tools.expand": true;
	"app.thinking.toggle": true;
	"app.session.toggleNamedFilter": true;
	"app.editor.external": true;
	"app.message.copy": true;
	"app.message.followUp": true;
	"app.message.dequeue": true;
	"app.clipboard.pasteImage": true;
	"app.session.new": true;
	"app.session.tree": true;
	"app.session.fork": true;
	"app.session.resume": true;
	"app.tree.foldOrUp": true;
	"app.tree.unfoldOrDown": true;
	"app.tree.editLabel": true;
	"app.tree.toggleLabelTimestamp": true;
	"app.session.togglePath": true;
	"app.session.toggleSort": true;
	"app.session.rename": true;
	"app.session.delete": true;
	"app.session.deleteNoninvasive": true;
	"app.models.toggle": true;
	"app.models.selectAll": true;
	"app.models.clearSelection": true;
	"app.tree.filter.default": true;
	"app.tree.filter.noTools": true;
	"app.tree.filter.userOnly": true;
	"app.tree.filter.labeledOnly": true;
	"app.tree.filter.all": true;
	"app.tree.filter.cycleForward": true;
	"app.tree.filter.cycleBackward": true;
}

export type AppKeybinding = keyof AppKeybindings;

export interface KeybindingsManager extends Pick<TuiKeybindingsManager, keyof TuiKeybindingsManager> {
	reload(): void;
	getEffectiveConfig(): KeybindingsConfig;
}
