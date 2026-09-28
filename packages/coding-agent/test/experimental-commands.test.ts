import { createFacetHost, defineFacet } from "@candy/chord";
import { describe, expect, test, vi } from "vitest";
import { Commands } from "../src/experimental/services/commands.ts";
import { CommandRegistry, createCommandsRuntimeFacet } from "../src/experimental/services/commands-provider.ts";

describe("experimental command facets", () => {
	test("registers and removes contributions", () => {
		const registry = new CommandRegistry();
		const snapshots: string[][] = [];
		const unsubscribe = registry.subscribe((commands) => snapshots.push(commands.map(({ name }) => name)));
		const close = registry.register({ name: "hello", description: "Hello", run: () => undefined });
		expect(registry.list().map(({ name }) => name)).toEqual(["hello"]);
		expect(() => registry.register({ name: "hello", run: () => undefined })).toThrow("already registered");
		close();
		close();
		expect(registry.list()).toEqual([]);
		expect(snapshots).toEqual([[], ["hello"], []]);
		unsubscribe();
	});

	test("identifies equal names by source", () => {
		const registry = new CommandRegistry();
		const first = registry.register({ source: "first", name: "hello", run: () => undefined });
		const second = registry.register({ source: "second", name: "hello", run: () => undefined });
		expect(registry.list().map(({ source, name }) => [source, name])).toEqual([
			["first", "hello"],
			["second", "hello"],
		]);
		first();
		second();
	});

	test("stages replacements until the previous registration retires", () => {
		const registry = new CommandRegistry();
		const first = { name: "hello", description: "First", run: () => undefined };
		const second = { name: "hello", description: "Second", run: () => undefined };
		const closeFirst = registry.register(first);
		const closeSecond = registry.replace(second);
		expect(registry.list()).toEqual([first]);

		closeSecond();
		expect(registry.list()).toEqual([first]);
		const closeReplacement = registry.replace(second);
		closeFirst();
		expect(registry.list()).toEqual([second]);
		closeReplacement();
		expect(registry.list()).toEqual([]);
	});

	test("tracks plugin facet reload and unload", async () => {
		const registry = new CommandRegistry();
		const originalRun = vi.fn();
		const host = await createFacetHost({
			facets: [
				createCommandsRuntimeFacet(registry),
				defineFacet({
					id: "@test/example-hello",
					setup(env) {
						const commands = env.use(Commands);
						env.onActivate(() =>
							env.own(commands.replace({ name: "hello", description: "Original", run: originalRun })),
						);
					},
				}),
			],
		});
		expect(registry.list().map(({ name }) => name)).toEqual(["hello"]);

		const failure = new Error("replacement failed");
		await expect(
			host.reload([
				defineFacet({
					id: "@test/example-hello",
					setup(env) {
						const commands = env.use(Commands);
						env.onActivate(() => {
							env.own(commands.replace({ name: "hello", description: "Failing", run: () => undefined }));
							throw failure;
						});
					},
				}),
			]),
		).rejects.toBe(failure);
		expect(registry.list()).toEqual([expect.objectContaining({ name: "hello", run: originalRun })]);

		const replacementRun = vi.fn();
		await host.reload([
			defineFacet({
				id: "@test/example-hello",
				setup(env) {
					const commands = env.use(Commands);
					env.onActivate(() =>
						env.own(commands.replace({ name: "hello", description: "Replacement", run: replacementRun })),
					);
				},
			}),
		]);
		expect(registry.list()).toEqual([
			expect.objectContaining({ name: "hello", description: "Replacement", run: replacementRun }),
		]);

		await host.dispose();
		expect(registry.list()).toEqual([]);
	});
});
