import { DEFAULT_RADIUS_GATEWAY, normalizeRadiusGatewayUrl } from "@candy/ai/providers/radius-config";

export const RADIUS_PROVIDER_ID = "radius";
export const ENV_RADIUS_GATEWAY = "CANDY_RADIUS_GATEWAY";

/** Radius gateway origin, honoring the `CANDY_RADIUS_GATEWAY` override. */
export function getRadiusGatewayUrl(): string {
	return normalizeRadiusGatewayUrl(process.env[ENV_RADIUS_GATEWAY] ?? DEFAULT_RADIUS_GATEWAY);
}
