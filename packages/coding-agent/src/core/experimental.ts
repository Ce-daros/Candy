export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.CANDY_EXPERIMENTAL === "1";
}
