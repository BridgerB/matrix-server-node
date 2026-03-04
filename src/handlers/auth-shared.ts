import { generateDeviceId, generateToken } from "../crypto.ts";
import type { RouterRequest } from "../router.ts";
import type { Storage } from "../storage/interface.ts";

/**
 * Creates a device session (access token, device ID, optional refresh token)
 * and persists it to storage. Shared by login and register handlers.
 *
 * Returns the generated tokens/IDs so callers can build their own response
 * (e.g. login adds well_known, register does not).
 */
export const createSessionAndRespond = async (
	storage: Storage,
	req: RouterRequest,
	userId: string,
	body: {
		device_id?: string;
		initial_device_display_name?: string;
		refresh_token?: boolean;
	},
): Promise<{
	accessToken: string;
	deviceId: string;
	refreshToken?: string;
}> => {
	const deviceId = body.device_id ?? generateDeviceId();
	const accessToken = generateToken();
	const refreshToken = body.refresh_token ? generateToken() : undefined;

	await storage.createSession({
		device_id: deviceId,
		user_id: userId,
		access_token: accessToken,
		access_token_hash: "",
		refresh_token: refreshToken,
		display_name: body.initial_device_display_name,
		last_seen_ip: req.raw.socket.remoteAddress ?? "unknown",
		last_seen_ts: Date.now(),
		user_agent: (req.headers["user-agent"] as string) ?? "",
	});

	return { accessToken, deviceId, refreshToken };
};
