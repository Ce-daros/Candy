import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeGeneratedModelCatalog } from "../scripts/write-generated-model-catalog.ts";

it("replaces obsolete shards and restores the previous catalog when requested", () => {
	const root = mkdtempSync(join(tmpdir(), "candy-model-catalog-"));
	try {
		const providersDir = join(root, "src", "providers");
		mkdirSync(providersDir, { recursive: true });
		writeFileSync(join(providersDir, "obsolete.models.ts"), "obsolete");
		writeFileSync(join(root, "src", "models.generated.ts"), "previous");

		const restore = writeGeneratedModelCatalog(providersDir, root, ["acme"]);
		expect(existsSync(join(providersDir, "acme.models.ts"))).toBe(true);
		expect(existsSync(join(providersDir, "obsolete.models.ts"))).toBe(false);
		restore();
		expect(existsSync(join(providersDir, "acme.models.ts"))).toBe(false);
		expect(readFileSync(join(providersDir, "obsolete.models.ts"), "utf8")).toBe("obsolete");
		expect(readFileSync(join(root, "src", "models.generated.ts"), "utf8")).toBe("previous");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
