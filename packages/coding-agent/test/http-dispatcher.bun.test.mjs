import assert from "node:assert/strict";
import test from "node:test";
import { HttpDispatcherHost } from "../src/core/http-dispatcher.ts";

test("Bun HTTP host applies proxy and idle timeout settings through fetch", { skip: process.versions.bun === undefined ? "Requires Bun fetch options" : false }, async () => {
	const originalFetch = globalThis.fetch;
	const originalHttpProxy = process.env.HTTP_PROXY;
	const originalHttpsProxy = process.env.HTTPS_PROXY;
	const originalNoProxy = process.env.NO_PROXY;
	const originalLowerNoProxy = process.env.no_proxy;
	let capturedInit;
	const stubFetch = async (_input, init) => {
		capturedInit = init;
		return new Response("ok");
	};
	delete process.env.HTTP_PROXY;
	delete process.env.HTTPS_PROXY;
	delete process.env.NO_PROXY;
	process.env.no_proxy = "localhost,127.0.0.1";
	globalThis.fetch = stubFetch;
	const host = new HttpDispatcherHost();
	try {
		await host.configure({ timeoutMs: 1_234, httpProxy: "http://proxy.example:8888" });
		await globalThis.fetch("https://example.test");
		assert.equal(capturedInit.timeout, 1_234);
		assert.deepEqual(capturedInit.proxy, { url: "http://proxy.example:8888", respectNoProxy: true });
		assert.equal(process.env.NO_PROXY, "localhost,127.0.0.1");

		await host.configure({ timeoutMs: 0, httpProxy: "http://proxy.example:8888" });
		await globalThis.fetch("http://example.test");
		assert.equal(capturedInit.timeout, false);
		assert.deepEqual(capturedInit.proxy, { url: "http://proxy.example:8888", respectNoProxy: true });
	} finally {
		await host.dispose();
		globalThis.fetch = originalFetch;
		if (originalHttpProxy === undefined) delete process.env.HTTP_PROXY;
		else process.env.HTTP_PROXY = originalHttpProxy;
		if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
		else process.env.HTTPS_PROXY = originalHttpsProxy;
		if (originalNoProxy === undefined) delete process.env.NO_PROXY;
		else process.env.NO_PROXY = originalNoProxy;
		if (originalLowerNoProxy === undefined) delete process.env.no_proxy;
		else process.env.no_proxy = originalLowerNoProxy;
	}
	assert.equal(globalThis.fetch, originalFetch);
});
