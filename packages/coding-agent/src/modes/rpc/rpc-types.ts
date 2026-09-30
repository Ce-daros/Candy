/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@candy/agent-core";
import type { ImageContent, Model } from "@candy/ai";
import type { PromptDisposition, QueuedInput, QueuedInputDisposition, SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CommandInfo, CommandInvocation } from "../../core/commands.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { InteractiveSettingId } from "../../core/interactive-setting-values.ts";
import type { ResolvedPaths } from "../../core/package-manager.ts";
import type { ResourceConfigurationItem, ResourceType } from "../../core/resource-configuration.ts";
import type { ResourceOperations } from "../../core/resource-operations.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-history.ts";
import type { Settings, SettingsScope } from "../../core/settings-manager.ts";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| ({ id?: string; type: "execute_command"; streamingBehavior?: "steer" | "followUp" } & CommandInvocation)
	| { id?: string; type: "abort" }
	| { id?: string; type: "clear_queue" }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_settings" }
	| {
			id?: string;
			type: "commit_setting";
			scope: SettingsScope;
			settingId: InteractiveSettingId;
			value?: unknown;
			clear?: boolean;
	  }
	| { id?: string; type: "save_default_model"; provider: string; modelId: string }
	| { id?: string; type: "get_resources" }
	| { id?: string; type: "get_resource_configuration"; scope: SettingsScope }
	| { id?: string; type: "toggle_resource"; scope: SettingsScope; resourceType: ResourceType; path: string }
	| { id?: string; type: "active_tools"; action: "get" }
	| { id?: string; type: "active_tools"; action: "set"; names: string[] }
	| { id?: string; type: "default_tools"; action: "get" }
	| { id?: string; type: "default_tools"; action: "save"; names?: string[]; clear?: boolean }
	| { id?: string; type: "read_instruction"; path: string }
	| { id?: string; type: "save_instruction"; path: string; content: string }
	| { id?: string; type: "reload_resources" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "get_available_thinking_levels" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "import_session"; inputPath: string; cwdOverride?: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_entries"; since?: string }
	| { id?: string; type: "get_tree" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands
	| { id?: string; type: "get_commands" };

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

export interface RpcSettingsCommitEvent {
	type: "settings_commit";
	scope: SettingsScope | "runtime";
	fields: Array<keyof Settings>;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting
	| { id?: string; type: "response"; command: "prompt"; success: true; data: { disposition: PromptDisposition } }
	| {
			id?: string;
			type: "response";
			command: "execute_command";
			success: true;
			data: { disposition: PromptDisposition };
	  }
	| { id?: string; type: "response"; command: "steer"; success: true; data: { disposition: QueuedInputDisposition } }
	| {
			id?: string;
			type: "response";
			command: "follow_up";
			success: true;
			data: { disposition: QueuedInputDisposition };
	  }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| {
			id?: string;
			type: "response";
			command: "clear_queue";
			success: true;
			data: { steering: QueuedInput[]; followUp: QueuedInput[] };
	  }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| {
			id?: string;
			type: "response";
			command: "get_settings";
			success: true;
			data: { global: Settings; project: Settings; projectTrusted: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "commit_setting";
			success: true;
			data: { scope: SettingsScope; settingId: InteractiveSettingId; cleared: boolean };
	  }
	| { id?: string; type: "response"; command: "save_default_model"; success: true }
	| {
			id?: string;
			type: "response";
			command: "get_resources";
			success: true;
			data: ReturnType<ResourceOperations["getInventory"]>;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_resource_configuration";
			success: true;
			data: {
				scope: SettingsScope;
				paths: { global: ResolvedPaths; project: ResolvedPaths };
				items: ResourceConfigurationItem[];
			};
	  }
	| { id?: string; type: "response"; command: "toggle_resource"; success: true; data: { enabled: boolean | null } }
	| { id?: string; type: "response"; command: "active_tools"; success: true; data: { names: string[] } }
	| { id?: string; type: "response"; command: "default_tools"; success: true; data: { names: string[] | null } }
	| { id?: string; type: "response"; command: "read_instruction"; success: true; data: { content: string } }
	| {
			id?: string;
			type: "response";
			command: "save_instruction";
			success: true;
			data: { saved: true; reloaded: boolean; error?: string };
	  }
	| { id?: string; type: "response"; command: "reload_resources"; success: true }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_thinking_levels";
			success: true;
			data: { levels: ThinkingLevel[] };
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "import_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_entries";
			success: true;
			data: { entries: SessionEntry[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_tree";
			success: true;
			data: { tree: SessionTreeNode[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: CommandInfo[] };
	  }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
	  };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };
