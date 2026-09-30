const localFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
	const requestUrl = new URL(input instanceof Request ? input.url : String(input));
	if (requestUrl.hostname === "127.0.0.1" || requestUrl.hostname === "localhost" || requestUrl.hostname === "::1") {
		return localFetch(input, init);
	}
	throw new Error(`Network access is disabled in unit tests: ${requestUrl.href}`);
};
