import { setKeybindings } from "@candy/tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	getAuthSelectorProviders,
	OAuthSelectorComponent,
} from "../src/modes/interactive/components/oauth-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { KeybindingsManager } from "../src/presentation/keybindings.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("OAuthSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("projects provider-owned auth options without provider-specific filtering", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const apiKeyOptions = getAuthSelectorProviders(runtime, "api_key");
		expect(
			apiKeyOptions.filter((option) => option.id === "anthropic" || option.id === "google-vertex"),
		).toMatchObject([
			{
				id: "anthropic",
				name: "Anthropic",
				authType: "api_key",
				method: { name: "Anthropic API key" },
			},
			{
				id: "google-vertex",
				name: "Google Vertex AI",
				authType: "api_key",
				method: { name: "Google Cloud credentials" },
			},
		]);
		expect(getAuthSelectorProviders(runtime, "oauth").filter((option) => option.id === "anthropic")).toMatchObject([
			{ id: "anthropic", name: "Anthropic", authType: "oauth" },
		]);
	});

	it("renders an option without compiled auth status as unconfigured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[{ id: "google", name: "Google", authType: "api_key", status: undefined }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("unconfigured");
		expect(output).not.toContain("✓ configured");
	});

	it("shows OAuth auth distinctly in the API key selector", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[{ id: "anthropic", name: "Anthropic", authType: "api_key", status: { type: "oauth", source: "OAuth" } }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("subscription configured");
	});

	it("shows environment API key auth as configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[{ id: "openai", name: "OpenAI", authType: "api_key", status: { type: "api_key", source: "OPENAI_API_KEY" } }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("✓ env: OPENAI_API_KEY");
		expect(output).not.toContain("unconfigured");
	});

	it("shows models.json API key auth as configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[
				{
					id: "local-proxy",
					name: "local-proxy",
					authType: "api_key",
					status: { type: "api_key", source: "key in models.json" },
				},
			],
			() => {},
			() => {},
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("✓ key in models.json");
	});

	it("shows models.json command auth as configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[
				{
					id: "op-proxy",
					name: "op-proxy",
					authType: "api_key",
					status: { type: "api_key", source: "command in models.json" },
				},
			],
			() => {},
			() => {},
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("✓ command in models.json");
	});
});
