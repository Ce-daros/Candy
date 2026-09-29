import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertExactModelIds,
	MODEL_DATA_MANIFEST_FILE,
	MODEL_DATA_SCHEMA_VERSION,
	type ModelDataStructure,
	readModelDataStructure,
	validateModelDataDirectory,
} from "../scripts/model-data.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function createFixture(): {
	dataDir: string;
	packageRoot: string;
	structure: ModelDataStructure;
	values: Record<string, unknown>;
} {
	const packageRoot = mkdtempSync(join(tmpdir(), "pi-model-data-"));
	temporaryRoots.push(packageRoot);
	const providersDir = join(packageRoot, "src", "providers");
	const dataDir = join(providersDir, "data");
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(
		join(packageRoot, "src", "models.generated.ts"),
		'import { TEST_PROVIDER_IMAGE_MODELS, TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\n',
	);
	writeFileSync(
		join(providersDir, "test-provider.models.ts"),
		'import values from "./data/test-provider.json" with { type: "json" };\n',
	);

	const structure: ModelDataStructure = {
		"test-provider": {
			"chat:model-a": "openai-completions",
		},
	};
	const values: Record<string, unknown> = {
		"chat:model-a": {
			type: "chat",
			id: "model-a",
			name: "Model A",
			api: "openai-completions",
			provider: "test-provider",
			baseUrl: "https://example.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		},
	};
	writeFixtureData(dataDir, values);
	return { dataDir, packageRoot, structure, values };
}

function writeFixtureData(
	dataDir: string,
	values: Record<string, unknown>,
	manifestSchemaVersion = MODEL_DATA_SCHEMA_VERSION,
	apiGroup = "openai-completions",
): void {
	const filename = "test-provider.json";
	const content = `${JSON.stringify({ [apiGroup]: values })}\n`;
	writeFileSync(join(dataDir, filename), content);
	writeFileSync(
		join(dataDir, MODEL_DATA_MANIFEST_FILE),
		`${JSON.stringify({ schemaVersion: manifestSchemaVersion })}\n`,
	);
}

describe("generated model data validation", () => {
	it("rejects a missing upstream model from an exact generated allowlist", () => {
		expect(() => assertExactModelIds("qwen-token-plan-individual", ["model-a", "model-b"], ["model-a"])).toThrow(
			"qwen-token-plan-individual model IDs do not match (missing: model-b)",
		);
	});

	it("rejects an unexpected model from an exact generated allowlist", () => {
		expect(() => assertExactModelIds("test-provider", ["model-a"], ["model-a", "model-b"])).toThrow(
			"test-provider model IDs do not match (extra: model-b)",
		);
	});

	it("reads and validates API-grouped model data", () => {
		const { dataDir, packageRoot, structure } = createFixture();
		expect(readModelDataStructure(packageRoot)).toEqual(structure);
		expect(() => validateModelDataDirectory(structure, dataDir)).not.toThrow();
	});

	it("rejects a missing model data directory", () => {
		const { dataDir, structure } = createFixture();
		rmSync(dataDir, { recursive: true });
		expect(() => validateModelDataDirectory(structure, dataDir)).toThrow("does not exist");
	});

	it.each([
		["id", "wrong-id", "has id"],
		["provider", "wrong-provider", "has provider"],
		["api", "anthropic-messages", "has api"],
	] as const)("rejects a wrong model %s", (field, value, expectedMessage) => {
		const fixture = createFixture();
		const model = fixture.values["chat:model-a"] as Record<string, unknown>;
		model[field] = value;
		writeFixtureData(fixture.dataDir, fixture.values);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow(expectedMessage);
	});

	it("rejects a model without a known type", () => {
		const fixture = createFixture();
		const model = fixture.values["chat:model-a"] as Record<string, unknown>;
		delete model.type;
		writeFixtureData(fixture.dataDir, fixture.values);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow(
			'expected "chat" or "image"',
		);
	});

	it("validates image models with output modalities and without chat limits", () => {
		const fixture = createFixture();
		const structure: ModelDataStructure = { "test-provider": { "image:image-a": "test-images" } };
		const image: Record<string, unknown> = {
			type: "image",
			id: "image-a",
			name: "Image A",
			api: "test-images",
			provider: "test-provider",
			baseUrl: "https://example.test/v1",
			input: ["text"],
			output: ["image", "text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		};
		const validate = () => {
			writeFixtureData(fixture.dataDir, { "image:image-a": image }, MODEL_DATA_SCHEMA_VERSION, "test-images");
			validateModelDataDirectory(structure, fixture.dataDir);
		};
		expect(validate).not.toThrow();

		delete image.output;
		expect(validate).toThrow("invalid output modalities");
		image.output = ["text"];
		expect(validate).toThrow("invalid output modalities");
	});

	it("rejects output modalities on chat models", () => {
		const fixture = createFixture();
		const model = fixture.values["chat:model-a"] as Record<string, unknown>;
		model.output = ["text"];
		writeFixtureData(fixture.dataDir, fixture.values);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow(
			"unsupported output modalities",
		);
	});

	it("rejects a model in the wrong API group", () => {
		const fixture = createFixture();
		writeFixtureData(fixture.dataDir, fixture.values, MODEL_DATA_SCHEMA_VERSION, "anthropic-messages");
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("grouped under API");
	});

	it("rejects duplicate model IDs across API groups", () => {
		const fixture = createFixture();
		const filename = "test-provider.json";
		const content = `${JSON.stringify({
			"openai-completions": fixture.values,
			"anthropic-messages": fixture.values,
		})}\n`;
		writeFileSync(join(fixture.dataDir, filename), content);
		writeFileSync(
			join(fixture.dataDir, MODEL_DATA_MANIFEST_FILE),
			`${JSON.stringify({ schemaVersion: MODEL_DATA_SCHEMA_VERSION })}\n`,
		);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("more than one API group");
	});

	it("rejects missing model IDs and invalid JSON", () => {
		const fixture = createFixture();
		writeFileSync(join(fixture.dataDir, "test-provider.json"), "{}\n");
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow(/model IDs/);
	});

	it("rejects an incompatible schema", () => {
		const fixture = createFixture();
		writeFixtureData(fixture.dataDir, fixture.values, MODEL_DATA_SCHEMA_VERSION + 1);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("model data schema");
	});

	it("rejects missing provider shards imported by the aggregator", () => {
		const { packageRoot } = createFixture();
		writeFileSync(
			join(packageRoot, "src", "models.generated.ts"),
			'import { TEST_PROVIDER_IMAGE_MODELS, TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\nimport { MISSING_IMAGE_MODELS, MISSING_MODELS } from "./providers/missing.models.ts";\n',
		);
		expect(() => readModelDataStructure(packageRoot)).toThrow("aggregator and provider shards do not match");
	});
});
