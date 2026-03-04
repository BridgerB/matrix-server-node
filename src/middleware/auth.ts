import { missingToken, unknownToken } from "../errors.ts";
import type { Middleware, RouterRequest } from "../router.ts";
import type { Storage } from "../storage/interface.ts";

export function extractAccessToken(req: RouterRequest): string {
	const authHeader = req.headers.authorization ?? "";
	const queryToken = req.query.get("access_token") ?? "";

	if (authHeader && queryToken) {
		throw missingToken(
			"Do not supply access_token as both a query parameter and in the Authorization header",
		);
	}

	if (queryToken) return queryToken;

	if (authHeader) {
		const parts = authHeader.split(" ", 2);
		if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
			throw missingToken("Invalid Authorization header");
		}
		return parts[1];
	}

	throw missingToken();
}

export function requireAuth(storage: Storage): Middleware {
	return async (req, next) => {
		const token = extractAccessToken(req);

		const session = await storage.getSessionByAccessToken(token);
		if (!session) {
			throw unknownToken();
		}

		req.userId = session.user_id;
		req.deviceId = session.device_id;
		req.accessToken = token;

		// Update last-seen (fire and forget)
		const ip = req.raw.socket.remoteAddress ?? "unknown";
		const userAgent = (req.headers["user-agent"] as string) ?? "";
		storage.touchSession(token, ip, userAgent).catch(() => {});

		return next(req);
	};
}
