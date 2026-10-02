import type { ApiKeyAuth, AuthCheck, OAuthAuth } from "@candy/ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	Input,
	moveSelection,
	Spacer,
	TruncatedText,
	visibleWindow,
} from "@candy/tui";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { dialogTitle, selectedRowLabel, selectionCursor, selectionMarkerSuffix, theme } from "../theme/theme.ts";
import { emptyLine, readListAction, scrollCounter } from "./list-scaffold.ts";

export type AuthSelectorProvider = {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
	method?: ApiKeyAuth | OAuthAuth;
	status?: AuthCheck;
};

export type AuthSelectorCatalog = Pick<ModelRuntime, "getProviders" | "getProviderAuthStatus" | "isUsingOAuth">;

export function getAuthSelectorProviders(
	runtime: AuthSelectorCatalog,
	authType?: "oauth" | "api_key",
): AuthSelectorProvider[] {
	const options: AuthSelectorProvider[] = [];
	for (const provider of runtime.getProviders()) {
		const authStatus = runtime.getProviderAuthStatus(provider.id);
		const status = authStatus.configured
			? {
					type: runtime.isUsingOAuth(provider.id) ? ("oauth" as const) : ("api_key" as const),
					source: authStatus.label ?? authStatus.source,
				}
			: undefined;
		if ((!authType || authType === "oauth") && provider.auth.oauth) {
			options.push({ id: provider.id, name: provider.name, authType: "oauth", method: provider.auth.oauth, status });
		}
		if ((!authType || authType === "api_key") && provider.auth.apiKey) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "api_key",
				method: provider.auth.apiKey,
				status,
			});
		}
	}
	return options.sort((a, b) => a.name.localeCompare(b.name));
}

export function formatAuthSelectorProviderType(authType: AuthSelectorProvider["authType"]): string {
	return authType === "oauth" ? "subscription" : "API key";
}

/**
 * Component that renders an auth provider selector
 */
export class OAuthSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to search input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private listContainer: Container;
	private allProviders: AuthSelectorProvider[];
	private filteredProviders: AuthSelectorProvider[];
	private selectedIndex: number = 0;
	private mode: "login" | "logout";
	private onSelectCallback: (providerId: string, authType: AuthSelectorProvider["authType"]) => void;
	private onCancelCallback: () => void;
	private showAuthTypeLabels: boolean;
	private availableHeight = 14;

	constructor(
		mode: "login" | "logout",
		providers: AuthSelectorProvider[],
		onSelect: (providerId: string, authType: AuthSelectorProvider["authType"]) => void,
		onCancel: () => void,
		initialSearchInput?: string,
	) {
		super();

		this.mode = mode;
		this.allProviders = providers;
		this.filteredProviders = providers;
		this.showAuthTypeLabels = new Set(providers.map((provider) => provider.authType)).size > 1;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Add title
		const title = mode === "login" ? "Choose a provider" : "Choose a provider to sign out";
		this.addChild(new TruncatedText(dialogTitle(title), 1, 0));
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider.id, selectedProvider.authType);
			}
		};
		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);

		// Initial render
		this.filterProviders(initialSearchInput ?? "");
	}

	setAvailableHeight(height: number): void {
		this.availableHeight = Math.max(6, height);
		this.updateList();
	}

	private filterProviders(query: string): void {
		this.filteredProviders = query
			? fuzzyFilter(
					this.allProviders,
					query,
					(provider) => `${provider.name} ${provider.id} ${provider.authType} ${provider.method?.name ?? ""}`,
				)
			: this.allProviders;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredProviders.length - 1)));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = Math.max(3, this.availableHeight - 5);
		const { start, end } = visibleWindow(this.selectedIndex, this.filteredProviders.length, maxVisible);

		for (let i = start; i < end; i++) {
			const provider = this.filteredProviders[i];
			if (!provider) continue;

			const isSelected = i === this.selectedIndex;

			const statusIndicator = this.formatStatusIndicator(provider);
			const authTypeLabel = this.showAuthTypeLabels
				? theme.fg("muted", ` [${formatAuthSelectorProviderType(provider.authType)}]`)
				: "";
			let line = "";
			if (isSelected) {
				line =
					`${selectionCursor(true)}${selectedRowLabel(provider.name, true)}${selectionMarkerSuffix(true)}` +
					authTypeLabel +
					statusIndicator;
			} else {
				line = `${selectionCursor(false)}${selectedRowLabel(provider.name, false)}${authTypeLabel}${statusIndicator}`;
			}

			this.listContainer.addChild(new TruncatedText(line, 1, 0));
		}

		if (start > 0 || end < this.filteredProviders.length) {
			this.listContainer.addChild(
				new TruncatedText(scrollCounter(this.selectedIndex, this.filteredProviders.length), 1, 0),
			);
		}

		// Show "no providers" if empty
		if (this.filteredProviders.length === 0) {
			const message =
				this.allProviders.length === 0
					? this.mode === "login"
						? "No providers available"
						: "No providers signed in. Open Sources to connect one."
					: "No matching providers";
			this.listContainer.addChild(new TruncatedText(emptyLine(message), 1, 0));
		}
	}

	private formatStatusIndicator(provider: AuthSelectorProvider): string {
		if (!provider.status) return theme.fg("muted", " • unconfigured");
		if (provider.status.type !== provider.authType) {
			const label = provider.status.type === "oauth" ? "subscription configured" : "API key configured";
			return theme.fg("muted", " • ") + theme.fg("warning", label);
		}
		if (
			!provider.status.source ||
			provider.status.source === "OAuth" ||
			provider.status.source === "stored credential"
		) {
			return theme.fg("success", " ✓ configured");
		}
		const source = /^[A-Z][A-Z0-9_]*(?:, [A-Z][A-Z0-9_]*)*$/.test(provider.status.source)
			? `env: ${provider.status.source}`
			: provider.status.source;
		return theme.fg("success", ` ✓ ${source}`);
	}

	handleInput(keyData: string): void {
		switch (readListAction(keyData)) {
			case "up":
				if (this.filteredProviders.length === 0) return;
				this.selectedIndex = moveSelection(this.selectedIndex, this.filteredProviders.length, -1, true);
				this.updateList();
				break;
			case "down":
				if (this.filteredProviders.length === 0) return;
				this.selectedIndex = moveSelection(this.selectedIndex, this.filteredProviders.length, 1, true);
				this.updateList();
				break;
			case "confirm": {
				const selectedProvider = this.filteredProviders[this.selectedIndex];
				if (selectedProvider) {
					this.onSelectCallback(selectedProvider.id, selectedProvider.authType);
				}
				break;
			}
			case "cancel":
				this.onCancelCallback();
				break;
			// Pass everything else to search input
			default:
				this.searchInput.handleInput(keyData);
				this.filterProviders(this.searchInput.getValue());
				break;
		}
	}
}
