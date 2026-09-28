import { readFileSync, writeFileSync } from "node:fs";
import type { Api, Model } from "@candy/ai/compat";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@candy/ai/compat";
import type { AutocompleteItem } from "@candy/tui";
import type { AgentSession } from "../../core/agent-session.ts";
import { DEFAULT_THINKING_LEVEL } from "../../core/defaults.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { CommandPanel, type CommandPanelAction, type CommandPanelOptions } from "./components/command-panel.ts";
import { theme } from "./theme/theme.ts";

export type PresentationSurface = "sources" | "details" | "history" | "agent" | "command";

export interface PresentationHost {
	session(): AgentSession;
	settings(): SettingsManager;
	mount(panel: CommandPanel): void;
	exit(): void;
	render(): void;
	read(title: string, content: string, onEdit?: () => Promise<string | undefined>): void;
	applyQuickSelection(signal: AbortSignal): Promise<void>;
	edit(title: string, content: string): Promise<string | undefined>;
	login(provider: string): Promise<void>;
	reload(): Promise<void>;
	skills(): Promise<void>;
	settingsActions(): CommandPanelAction[];
	localCommands(): CommandPanelAction[];
	historyCommands(): CommandPanelAction[];
	completeArguments?(text: string, signal: AbortSignal, force?: boolean): Promise<AutocompleteItem[] | null>;
	historyAction(
		action: "compact" | "details" | "rename" | "tree" | "fork" | "clone" | "resume",
		args: string,
	): Promise<void>;
}

interface PresentationPage {
	kind: PresentationSurface;
	panel: CommandPanel;
	refresh: () => void;
	controller: AbortController;
}

function action(
	id: string,
	name: string,
	execute: CommandPanelAction["execute"],
	description?: string,
	argumentMode: CommandPanelAction["argumentMode"] = "none",
): CommandPanelAction {
	return { id, name, execute, description, argumentMode };
}

export class InteractivePresentation {
	private readonly host: PresentationHost;
	private pages: PresentationPage[] = [];
	private session: AgentSession | undefined;
	private scopeChanged = false;
	private closing = false;

	constructor(host: PresentationHost) {
		this.host = host;
	}

	get active(): boolean {
		return this.pages.length > 0;
	}

	get surface(): PresentationSurface | undefined {
		return this.pages[0]?.kind;
	}

	open(surface: PresentationSurface, model?: Model<Api>): void {
		this.dispose();
		this.session = this.host.session();
		switch (surface) {
			case "sources":
				this.openSources();
				break;
			case "details":
				if (model) this.openDetails(model);
				break;
			case "history":
				this.openHistory();
				break;
			case "agent":
				this.openAgent();
				break;
			case "command":
				this.openCommand();
				break;
		}
	}

	resume(): boolean {
		const page = this.pages.at(-1);
		if (!page || this.session !== this.host.session()) return false;
		page.refresh();
		page.panel.resume();
		this.host.mount(page.panel);
		return true;
	}

	suspendFor(content: object): void {
		const page = this.pages.at(-1);
		if (page && page.panel !== content) page.panel.suspend();
	}

	finish(): void {
		this.dispose();
		this.host.exit();
	}

	dispose(): void {
		for (const page of this.pages) {
			page.controller.abort();
			page.panel.dispose();
		}
		this.pages = [];
		this.session = undefined;
		this.scopeChanged = false;
		this.closing = false;
	}

	private back(): void {
		if (this.closing) return;
		if (this.pages.length === 1 && this.scopeChanged) {
			const page = this.pages[0];
			this.closing = true;
			page.panel.suspend();
			void this.host.applyQuickSelection(page.controller.signal).finally(() => {
				if (page.controller.signal.aborted || this.session !== this.host.session()) return;
				this.finish();
			});
			return;
		}
		const page = this.pages.pop();
		page?.controller.abort();
		page?.panel.dispose();
		if (!this.resume()) this.finish();
	}

	private page(
		kind: PresentationSurface,
		title: string,
		getActions: (page: PresentationPage) => CommandPanelAction[],
		getDescription: () => string = () => "",
		onSelectionChange?: CommandPanelOptions["onSelectionChange"],
		searchable = kind === "command" || kind === "sources",
	): PresentationPage {
		this.pages.at(-1)?.panel.suspend();
		const panel = new CommandPanel([], {
			title,
			onCancel: () => this.back(),
			onMessage: () => this.finish(),
			requestRender: () => this.host.render(),
			onSelectionChange,
			searchable,
		});
		const page: PresentationPage = {
			kind,
			panel,
			controller: new AbortController(),
			refresh: () => {
				panel.setActions(getActions(page));
				panel.setDescription(getDescription());
			},
		};
		this.pages.push(page);
		page.refresh();
		this.host.mount(panel);
		return page;
	}

	private refresh(page: PresentationPage): void {
		if (this.pages.at(-1) !== page || this.session !== this.host.session()) return;
		page.refresh();
		this.host.render();
	}

	private openSources(): void {
		const runtime = this.host.session().modelRuntime;
		const settings = this.host.settings();
		this.page(
			"sources",
			"Sources · Providers",
			(page) => [
				...runtime.getProviders().map((provider) => {
					const status = runtime.getProviderAuthStatus(provider.id);
					return action(
						provider.id,
						provider.name,
						async () => this.openProvider(provider.id),
						`${status.configured ? (status.label ?? status.source) : "Not connected"} · ${runtime.getModels(provider.id).length} models`,
					);
				}),
				...Array.from(
					new Set(
						(settings.getScopedModels() ?? [])
							.map((model) => model.provider)
							.filter((id) => !runtime.getProvider(id)),
					),
				).map((id) => action(id, id, async () => this.openProvider(id), "Unavailable")),
				action("all", "Use all available models", async () => {
					if (settings.getScopedModels() === undefined) return;
					this.markScopeChanged();
					settings.setScopedModels(undefined);
					this.refresh(page);
				}),
				action("none", "Clear quick selection", async () => {
					if (settings.getScopedModels()?.length === 0) return;
					this.markScopeChanged();
					settings.setScopedModels([]);
					this.refresh(page);
				}),
			],
			() => {
				const scope = settings.getScopedModels();
				return scope === undefined
					? "Quick selection: all available models"
					: `Quick selection: ${scope.length} models`;
			},
		);
	}

	private markScopeChanged(): void {
		const session = this.host.session();
		if (session.isStreaming || session.isCompacting)
			throw new Error("Wait for the current response or compaction to finish");
		this.scopeChanged = true;
	}

	private openProvider(providerId: string): void {
		const runtime = this.host.session().modelRuntime;
		const settings = this.host.settings();
		const provider = runtime.getProvider(providerId);
		let catalogStatus = `${runtime.getModels(providerId).length} models`;
		let credentialStatus: CommandPanelAction["status"];
		let savedCredentialType: string | undefined;
		const loadCredentials = async (): Promise<void> => {
			const credentials = await runtime.listCredentials({ signal: page.controller.signal });
			savedCredentialType = credentials.find((entry) => entry.providerId === providerId)?.type;
			this.refresh(page);
		};
		const setSelected = (ids: string[], checked: boolean): void => {
			if (ids.length === 0) return;
			const modelIds = new Set(ids.map((id) => id.slice("model:".length)));
			const selected =
				settings.getScopedModels() ??
				runtime.getAvailableSnapshot().map((model) => ({ provider: model.provider, modelId: model.id }));
			if (
				[...modelIds].every(
					(id) => selected.some((ref) => ref.provider === providerId && ref.modelId === id) === checked,
				)
			)
				return;
			this.markScopeChanged();
			settings.setScopedModels([
				...selected.filter((ref) => ref.provider !== providerId || !modelIds.has(ref.modelId)),
				...(checked ? [...modelIds].map((modelId) => ({ provider: providerId, modelId })) : []),
			]);
			this.refresh(page);
		};
		const page = this.page(
			"sources",
			provider?.name ?? providerId,
			(current) => {
				const scope = settings.getScopedModels();
				const available = runtime.getAvailableSnapshot();
				const models = runtime.getModels(providerId);
				const refs = [
					...models.map((model) => ({ provider: providerId, modelId: model.id })),
					...(scope ?? []).filter(
						(ref) => ref.provider === providerId && !models.some((model) => model.id === ref.modelId),
					),
				];
				return [
					...(provider
						? [
								action("login", "Connect", async () => {
									await this.host.login(providerId);
									credentialStatus = undefined;
									await loadCredentials();
								}),
								...(savedCredentialType
									? [
											action("logout", "Remove saved credentials", async () => {
												await runtime.logout(providerId, { signal: current.controller.signal });
												credentialStatus = undefined;
												await loadCredentials();
											}),
										]
									: []),
								{
									...action("check", "Check authentication", async () => {
										credentialStatus = { text: "Checking…", tone: "muted" };
										this.refresh(current);
										try {
											const auth = await runtime.checkAuth(providerId, {
												signal: current.controller.signal,
											});
											credentialStatus = auth
												? { text: `${auth.type} · ${auth.source ?? providerId}`, tone: "success" }
												: { text: "Not connected", tone: "error" };
										} catch (error) {
											if (current.controller.signal.aborted) return;
											credentialStatus = {
												text: "Check failed",
												tone: "error",
												detail: error instanceof Error ? error.message : String(error),
											};
										}
										this.refresh(current);
									}),
									status:
										credentialStatus ??
										(runtime.getProviderAuthStatus(providerId).configured
											? {
													text: runtime.getProviderAuthStatus(providerId).label ?? "Configured",
													tone: "muted" as const,
												}
											: { text: "Not connected", tone: "error" as const }),
								},
								action("refresh", "Refresh catalog", async () => {
									const result = await runtime.refresh({
										providers: [providerId],
										signal: current.controller.signal,
									});
									if (result.aborted) return;
									const error = result.errors.get(providerId);
									catalogStatus = error
										? `Refresh failed: ${error.message}`
										: `${runtime.getModels(providerId).length} models`;
									this.refresh(current);
								}),
							]
						: []),
					action("select-all", "Select all provider models", async () =>
						setSelected(
							refs.map((ref) => `model:${ref.modelId}`),
							true,
						),
					),
					action("clear-all", "Clear provider selection", async () =>
						setSelected(
							refs.map((ref) => `model:${ref.modelId}`),
							false,
						),
					),
					...refs.map((ref) => {
						const model = models.find((entry) => entry.id === ref.modelId);
						const usable = available.some((entry) => entry.provider === providerId && entry.id === ref.modelId);
						const enabled =
							scope === undefined
								? usable
								: scope.some((entry) => entry.provider === providerId && entry.modelId === ref.modelId);
						return {
							...action(
								`model:${ref.modelId}`,
								model?.name ?? ref.modelId,
								async () => {
									setSelected([`model:${ref.modelId}`], !enabled);
								},
								`${ref.modelId}${usable ? "" : " · Unavailable"}`,
							),
							checked: enabled,
							searchText: `${model?.name ?? ref.modelId} ${ref.modelId}`,
						};
					}),
				];
			},
			() => {
				const scope = settings.getScopedModels();
				const count =
					scope === undefined
						? runtime.getAvailableSnapshot().filter((model) => model.provider === providerId).length
						: scope.filter((ref) => ref.provider === providerId).length;
				return `Catalog: ${catalogStatus} · Selected: ${count}`;
			},
			setSelected,
		);
		void loadCredentials().catch((error: unknown) => {
			if (page.controller.signal.aborted) return;
			credentialStatus = {
				text: "Credentials unavailable",
				tone: "error",
				detail: error instanceof Error ? error.message : String(error),
			};
			this.refresh(page);
		});
	}

	private openDetails(model: Model<Api>): void {
		const settings = this.host.settings();
		const sourceName = (source: string): string =>
			source === "default" ? "Built-in" : source === "global" ? "User" : source === "project" ? "Project" : source;
		const fact = (label: string, value: string): string => `${theme.fg("muted", label)} ${theme.fg("text", value)}`;
		const page = this.page(
			"details",
			model.name,
			() => {
				const thinking = settings.getModelThinkingSettingWithSource(model);
				const requested = thinking.requested ?? DEFAULT_THINKING_LEVEL;
				const effective = clampThinkingLevel(model, requested);
				const cycleThinking = async (direction: 1 | -1): Promise<void> => {
					const values = [undefined, ...getSupportedThinkingLevels(model)];
					const current = settings.getModelThinkingSettingWithSource(model).savedGlobalOverride;
					const index = values.indexOf(current);
					const next = values[(index + direction + values.length) % values.length];
					if (next === undefined) settings.removeModelThinkingLevel(model.provider, model.id);
					else settings.setModelThinkingLevel(model.provider, model.id, next);
					this.refresh(page);
				};
				return [
					{
						...action(
							"thinking",
							"Default thinking",
							() => cycleThinking(1),
							`${effective} · ${sourceName(thinking.source)}${requested === effective ? "" : ` (requested ${requested})`}${thinking.savedGlobalOverride !== undefined && thinking.savedGlobalOverride !== requested ? ` · Saved ${thinking.savedGlobalOverride}` : ""}`,
						),
						cycle: cycleThinking,
						reset:
							thinking.savedGlobalOverride === undefined
								? undefined
								: async () => {
										settings.removeModelThinkingLevel(model.provider, model.id);
										this.refresh(page);
									},
					},
					...(["reserveTokens", "keepRecentTokens"] as const).map((field) => {
						const setting = settings.getCompactionTokenSettingsWithSources(model)[field];
						const saved =
							settings.getGlobalSettings().compaction?.modelOverrides?.[`${model.provider}/${model.id}`]?.[
								field
							];
						return {
							...action(
								field,
								field === "reserveTokens" ? "Reserve tokens" : "Keep recent tokens",
								async (args) => {
									if (!/^\d+$/.test(args) || !Number.isSafeInteger(Number(args)))
										throw new Error("Enter a non-negative whole number");
									settings.setModelCompactionOverride(model.provider, model.id, field, Number(args));
									this.refresh(page);
								},
								`${setting.value.toLocaleString()} · ${sourceName(setting.source)}${saved !== undefined && saved !== setting.value ? ` · Saved ${saved.toLocaleString()}` : ""}`,
								"single",
							),
							inline: true,
							initialArgs: String(setting.value),
							reset:
								saved === undefined
									? undefined
									: async () => {
											settings.setModelCompactionOverride(model.provider, model.id, field, undefined);
											this.refresh(page);
										},
						};
					}),
					action(
						"default",
						"Set as default",
						async () => {
							settings.setDefaultModelAndProvider(model.provider, model.id);
							this.refresh(page);
						},
						settings.getDefaultProvider() === model.provider && settings.getDefaultModel() === model.id
							? "Default"
							: undefined,
					),
				];
			},
			() =>
				[
					`${model.provider} · ${model.id}`,
					`${fact("Context", model.contextWindow.toLocaleString())}   ${fact("Output", model.maxTokens.toLocaleString())}`,
					`${fact("Input", model.input.join(", "))}   ${fact("Reasoning", model.reasoning ? "Yes" : "No")}`,
					`${fact("Price / 1M", `input $${model.cost.input} · output $${model.cost.output}`)}`,
					fact("Cache / 1M", `read $${model.cost.cacheRead} · write $${model.cost.cacheWrite}`),
				].join("\n"),
		);
	}

	private openHistory(): void {
		this.page(
			"history",
			"History",
			() => [
				...this.host
					.historyCommands()
					.map((item) => ({ ...item, group: item.id === "new" ? "Sessions" : "Files" })),
				action("context", "Context", async () => {
					const usage = this.host.session().getContextUsage();
					this.host.read(
						"Context",
						usage
							? `Tokens: ${usage.tokens ?? "Unknown"}\n\nContext window: ${usage.contextWindow}\n\nUsed: ${usage.percent === null ? "Unknown" : `${usage.percent.toFixed(1)}%`}`
							: "Context usage unavailable",
					);
				}),
				...(
					[
						["compact", "Compact", "single"],
						["details", "Session details", "none"],
						["rename", "Rename", "single"],
						["tree", "Tree", "none"],
						["fork", "Fork", "none"],
						["clone", "Clone", "none"],
						["resume", "Resume / Switch session", "none"],
					] as const
				).map(([id, name, mode]) => ({
					...action(
						id,
						name,
						async (args) => this.host.historyAction(id, args),
						id === "rename" ? this.host.session().sessionManager.getSessionName() : undefined,
						mode,
					),
					initialArgs: id === "rename" ? this.host.session().sessionManager.getSessionName() : undefined,
					inline: id === "rename",
					group: id === "details" || id === "compact" || id === "rename" ? "Current session" : "Sessions",
				})),
			],
			undefined,
			undefined,
			true,
		);
	}

	private openAgent(): void {
		this.page("agent", "Agent", () => [
			action("instructions", "Instructions", async () => this.openInstructions()),
			action("skills", "Skills", async () => this.openSkills()),
			action("tools", "Tools", async () => this.openTools()),
			action("behavior", "Behavior", async () => this.openBehavior()),
		]);
	}

	private openInstructions(): void {
		const session = this.host.session();
		const loader = session.resourceLoader;
		const source = loader.getSystemPromptSource();
		const files = [
			...(source ? [source] : []),
			...loader.getAppendSystemPromptSources(),
			...loader.getAgentsFiles().agentsFiles,
		];
		this.page(
			"agent",
			"Instructions",
			() => [
				action("effective", "Effective instructions", async () =>
					this.host.read("Instructions", session.systemPrompt),
				),
				...files.map((file) =>
					action(file.path, file.path, async () => {
						this.host.read(file.path, readFileSync(file.path, "utf8"), async () => {
							const content = await this.host.edit(file.path, readFileSync(file.path, "utf8"));
							if (content === undefined || session !== this.host.session()) return;
							if (session.isStreaming || session.isCompacting)
								throw new Error("Wait for the current response or compaction to finish");
							writeFileSync(file.path, content);
							await this.host.reload();
							return content;
						});
					}),
				),
			],
			undefined,
			undefined,
			true,
		);
	}

	private async openSkills(): Promise<void> {
		await this.host.skills();
	}

	private openTools(): void {
		const session = this.host.session();
		this.page(
			"agent",
			"Tools",
			(page) => [
				action("save", "Save current tools as default", async () => {
					this.host.settings().setDefaultTools(session.getActiveToolNames());
					this.refresh(page);
				}),
				action("clear-default", "Use inherited default tools", async () => {
					this.host.settings().setDefaultTools(undefined);
					this.refresh(page);
				}),
				...session.getAllTools().map((tool) => ({
					...action(
						tool.name,
						tool.name,
						async () =>
							this.host.read(
								tool.name,
								`${tool.description}\n\n\`\`\`json\n${JSON.stringify(tool.parameters, null, 2)}\n\`\`\``,
							),
						tool.sourceInfo?.path,
					),
					checked: session.getActiveToolNames().includes(tool.name),
					toggle: async () => {
						if (session.isStreaming || session.isCompacting)
							throw new Error("Wait for the current response or compaction to finish");
						const active = session.getActiveToolNames();
						session.setActiveToolsByName(
							active.includes(tool.name) ? active.filter((name) => name !== tool.name) : [...active, tool.name],
						);
						this.refresh(page);
					},
				})),
			],
			() => {
				const settings = this.host.settings();
				const saved = settings.getGlobalSettings().defaultTools;
				const effective = settings.getDefaultTools();
				return `Next session: ${effective === undefined ? "Built-in defaults" : effective.length ? effective.join(", ") : "None"}${saved === undefined ? " · Inherited" : ""}`;
			},
			undefined,
			true,
		);
	}

	private openBehavior(): void {
		const session = this.host.session();
		this.page("agent", "Behavior", (page) => [
			action("steering", `Steering: ${session.steeringMode}`, async () => {
				session.setSteeringMode(session.steeringMode === "all" ? "one-at-a-time" : "all");
				this.refresh(page);
			}),
			action("follow-up", `Follow-up: ${session.followUpMode}`, async () => {
				session.setFollowUpMode(session.followUpMode === "all" ? "one-at-a-time" : "all");
				this.refresh(page);
			}),
			action("retry", `Automatic retry: ${session.autoRetryEnabled ? "On" : "Off"}`, async () => {
				session.setAutoRetryEnabled(!session.autoRetryEnabled);
				this.refresh(page);
			}),
		]);
	}

	private openCommand(): void {
		this.page("command", "Command", (page) => [
			...this.host.localCommands().map((item) => ({ ...item, group: "Commands" })),
			...this.host.settingsActions().map((item) => ({ ...item, group: "Settings" })),
			...this.host
				.session()
				.getCommands()
				.filter((command) => command.source !== "skill" || this.host.settings().getEnableSkillCommands())
				.map((command) => ({
					id: `${command.source}:${command.name}`,
					group: "Resources",
					name: command.name,
					description: command.description,
					source: command.sourceInfo?.path ?? command.source,
					argumentHint: command.argumentHint,
					argumentMode: "optional" as const,
					getArgumentCompletions: async (text: string, signal: AbortSignal, force?: boolean) => {
						if (command.source === "extension") {
							const custom = await this.host
								.session()
								.extensionRunner.getCommand(command.name)
								?.getArgumentCompletions?.(text);
							if (custom?.length) return custom;
						}
						return (await this.host.completeArguments?.(text, signal, force)) ?? null;
					},
					execute: async (args: string) => {
						if (command.source !== "extension" && !this.host.session().model) {
							throw new Error("Select a model before sending a message");
						}
						await this.host.session().executeCommand(
							{ source: command.source, name: command.name, args },
							{
								streamingBehavior: "steer",
								preflightResult: (disposition) => {
									if (
										command.source !== "extension" &&
										disposition !== "handled" &&
										this.pages.at(-1) === page &&
										this.session === this.host.session()
									)
										this.finish();
								},
							},
						);
						return command.source === "extension" ? ("stay" as const) : ("message" as const);
					},
				})),
		]);
	}
}
