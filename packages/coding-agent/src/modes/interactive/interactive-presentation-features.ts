import { type Api, clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@candy/ai";
import { DEFAULT_THINKING_LEVEL } from "../../core/defaults.ts";
import type { CommandPanelAction, CommandPanelOptions } from "./components/command-panel.ts";
import type { PresentationHost, PresentationPage } from "./interactive-presentation.ts";
import { theme } from "./theme/theme.ts";

type PageFactory = (
	kind: PresentationPage["kind"],
	title: string,
	getActions: (page: PresentationPage) => CommandPanelAction[],
	getDescription?: () => string,
	onSelectionChange?: CommandPanelOptions["onSelectionChange"],
	searchable?: boolean,
) => PresentationPage;
type RefreshPage = (page: PresentationPage) => void;

function action(
	id: string,
	name: string,
	execute: CommandPanelAction["execute"],
	description?: string,
	argumentMode: CommandPanelAction["argumentMode"] = "none",
): CommandPanelAction {
	return { id, name, execute, description, argumentMode };
}

class FeatureController {
	protected readonly host: PresentationHost;
	protected readonly page: PageFactory;
	protected readonly refresh: RefreshPage;

	constructor(host: PresentationHost, page: PageFactory, refresh: RefreshPage) {
		this.host = host;
		this.page = page;
		this.refresh = refresh;
	}
}

export class SourcesController extends FeatureController {
	private readonly onScopeChanged: () => void;
	private readonly ensureScopeEditable: () => void;
	constructor(
		host: PresentationHost,
		page: PageFactory,
		refresh: RefreshPage,
		markScopeChanged: () => void,
		assertScopeEditable: () => void,
	) {
		super(host, page, refresh);
		this.onScopeChanged = markScopeChanged;
		this.ensureScopeEditable = assertScopeEditable;
	}
	private assertScopeEditable(): void {
		this.ensureScopeEditable();
	}

	private markScopeChanged(): void {
		this.onScopeChanged();
	}
	openSources(): void {
		const runtime = this.host.models();
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
					this.assertScopeEditable();
					await settings.commitSetting("global", "scopedModels", undefined);
					this.markScopeChanged();
					this.refresh(page);
				}),
				action("none", "Clear quick selection", async () => {
					if (settings.getScopedModels()?.length === 0) return;
					this.assertScopeEditable();
					await settings.commitSetting("global", "scopedModels", []);
					this.markScopeChanged();
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

	private openProvider(providerId: string): void {
		const runtime = this.host.models();
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
		const setSelected = async (ids: string[], checked: boolean): Promise<void> => {
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
			this.assertScopeEditable();
			await settings.commitSetting("global", "scopedModels", [
				...selected.filter((ref) => ref.provider !== providerId || !modelIds.has(ref.modelId)),
				...(checked ? [...modelIds].map((modelId) => ({ provider: providerId, modelId })) : []),
			]);
			this.markScopeChanged();
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
											const availability = await runtime.getAvailability(providerId, {
												signal: current.controller.signal,
											});
											const auth = availability.providers.find(
												(entry) => entry.providerId === providerId,
											)?.auth;
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
									await setSelected([`model:${ref.modelId}`], !enabled);
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
}

export class DetailsController extends FeatureController {
	openDetails(model: Model<Api>): void {
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
					await settings.commitModelThinkingLevel(model.provider, model.id, next);
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
										await settings.commitModelThinkingLevel(model.provider, model.id, undefined);
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
									await settings.commitModelCompactionOverride(model.provider, model.id, field, Number(args));
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
											await settings.commitModelCompactionOverride(
												model.provider,
												model.id,
												field,
												undefined,
											);
											this.refresh(page);
										},
						};
					}),
					action(
						"default",
						"Set as default",
						async () => {
							await settings.commitDefaultModelAndProvider(model.provider, model.id);
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
}

export class HistoryController extends FeatureController {
	openHistory(): void {
		this.page(
			"history",
			"History",
			() => [
				...this.host
					.historyCommands()
					.map((item) => ({ ...item, group: item.id === "local:New session" ? "Sessions" : "Files" })),
				action("context", "Context", async () => {
					const usage = this.host.session().execution.getContextUsage();
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
						id === "rename" ? this.host.session().history.getSessionName() : undefined,
						mode,
					),
					initialArgs: id === "rename" ? this.host.session().history.getSessionName() : undefined,
					inline: id === "rename",
					group: id === "details" || id === "compact" || id === "rename" ? "Current session" : "Sessions",
				})),
			],
			undefined,
			undefined,
			true,
		);
	}
}

export class AgentController extends FeatureController {
	openAgent(): void {
		this.page("agent", "Agent", () => [
			action("instructions", "Instructions", async () => this.openInstructions()),
			action("skills", "Skills", async () => this.openSkills()),
			action("tools", "Tools", async () => this.openTools()),
			action("behavior", "Behavior", async () => this.openBehavior()),
		]);
	}

	private openInstructions(): void {
		const session = this.host.session();
		const resources = session.resources;
		const files = resources.getInventory().instructions;
		const drafts = new Map<string, string>();
		this.page(
			"agent",
			"Instructions",
			() => [
				action("effective", "Effective instructions", async () =>
					this.host.read("Instructions", session.execution.systemPrompt),
				),
				...files.map((file) =>
					action(file.path, file.path, async () => {
						this.host.read(file.path, await resources.readInstruction(file.path), async () => {
							const original = drafts.get(file.path) ?? (await resources.readInstruction(file.path));
							const content = await this.host.edit(file.path, original);
							if (content === undefined || session !== this.host.session()) return;
							drafts.set(file.path, content);
							const result = await resources.saveInstruction(file.path, content);
							if (!result.reloaded)
								this.host.reportError(
									`Saved ${file.path}, but resource reload failed: ${result.error.message}`,
								);
							else drafts.delete(file.path);
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
					await session.resources.saveDefaultTools(session.execution.getActiveToolNames());
					this.refresh(page);
				}),
				action("clear-default", "Use inherited default tools", async () => {
					await session.resources.saveDefaultTools(undefined);
					this.refresh(page);
				}),
				...session.execution.getAllTools().map((tool) => ({
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
					checked: session.execution.getActiveToolNames().includes(tool.name),
					toggle: async () => {
						const active = session.execution.getActiveToolNames();
						session.resources.setActiveTools(
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
			action("steering", `Steering: ${session.execution.steeringMode}`, async () => {
				await session.execution.setSteeringMode(session.execution.steeringMode === "all" ? "one-at-a-time" : "all");
				this.refresh(page);
			}),
			action("follow-up", `Follow-up: ${session.execution.followUpMode}`, async () => {
				await session.execution.setFollowUpMode(session.execution.followUpMode === "all" ? "one-at-a-time" : "all");
				this.refresh(page);
			}),
			action("retry", `Automatic retry: ${session.execution.autoRetryEnabled ? "On" : "Off"}`, async () => {
				await session.execution.setAutoRetryEnabled(!session.execution.autoRetryEnabled);
				this.refresh(page);
			}),
		]);
	}
}

export class CommandController extends FeatureController {
	private readonly isCurrentPage: (page: PresentationPage) => boolean;
	private readonly finishPresentation: () => void;
	constructor(
		host: PresentationHost,
		page: PageFactory,
		refresh: RefreshPage,
		isCurrentPage: (page: PresentationPage) => boolean,
		finishPresentation: () => void,
	) {
		super(host, page, refresh);
		this.isCurrentPage = isCurrentPage;
		this.finishPresentation = finishPresentation;
	}

	openCommand(): void {
		this.page("command", "Command", (page) => [
			...this.host.localCommands().map((item) => ({ ...item, group: "Commands" })),
			...this.host.settingsActions().map((item) => ({ ...item, group: "Settings" })),
			...this.host
				.session()
				.execution.getCommands()
				.filter((command) => command.source !== "skill" || this.host.settings().read("skill-commands"))
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
								.execution.extensionRunner.getCommand(command.name)
								?.getArgumentCompletions?.(text);
							if (custom?.length) return custom;
						}
						return (await this.host.completeArguments?.(text, signal, force)) ?? null;
					},
					execute: async (args: string) => {
						if (command.source !== "extension" && !this.host.session().selection.model) {
							throw new Error("Select a model before sending a message");
						}
						await this.host.session().execution.executeCommand(
							{ source: command.source, name: command.name, args },
							{
								streamingBehavior: "steer",
								preflightResult: (disposition) => {
									if (command.source !== "extension" && disposition !== "handled" && this.isCurrentPage(page))
										this.finishPresentation();
								},
							},
						);
						return command.source === "extension" ? ("stay" as const) : ("message" as const);
					},
				})),
		]);
	}
}
