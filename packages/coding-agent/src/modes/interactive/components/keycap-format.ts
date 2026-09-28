export interface KeyTextFormatOptions {
	capitalize?: boolean;
}

function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}

export function formatKeycap(key: string, colorize: (text: string) => string): string {
	if (key === "") return "";
	if (key === "/") return colorize("</>");
	return key
		.split("/")
		.map((part) => colorize(`<${formatKeyText(part, { capitalize: true })}>`))
		.join("/");
}
