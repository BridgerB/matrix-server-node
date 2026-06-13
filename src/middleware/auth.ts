import { findAppserviceByToken } from "../appservice/registration.ts";
import {
	forbidden,
	missingToken,
	unknownToken,
	userDeactivated,
} from "../errors.ts";
import type { Middleware, RouterRequest } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { AppserviceRegistration } from "../types/appservice.ts";
import type { DeviceId, ServerName, UserId } from "../types/index.ts";

export const extractAccessToken = (req: RouterRequest): string => {
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
		if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1])
			throw missingToken("Invalid Authorization header");
		return parts[1];
	}

	throw missingToken();
};

export const requireAuth =
	(
		storage: Storage,
		registrations: AppserviceRegistration[] = [],
		serverName = "",
	): Middleware =>
	async (req, next) => {
		const token = extractAccessToken(req);

		const session = await storage.getSessionByAccessToken(token);
		if (session) {
			const account = await storage.getUserById(session.user_id as UserId);
			if (account?.is_deactivated) throw userDeactivated();

			req.userId = session.user_id;
			req.deviceId = session.device_id;
			req.accessToken = token;

			const ip = req.raw.socket.remoteAddress ?? "unknown";
			const userAgent = (req.headers["user-agent"] as string) ?? "";
			storage.touchSession(token, ip, userAgent).catch(() => {});

			return next(req);
		}

		// Fall back to application-service token auth. An appservice may act on the
		// normal Client-Server API as any user inside its `users` namespace (or its
		// own sender_localpart user), selecting which user via the `?user_id=` query
		// param. This lets bridge users (e.g. joining a federated room) authenticate
		// with the appservice's `as_token` rather than a per-user access token.
		const reg = findAppserviceByToken(token, registrations);
		if (!reg) throw unknownToken();

		const senderUser = `@${reg.sender_localpart}:${serverName}`;
		const masqueradeUserId = req.query.get("user_id");
		let asUserId: string;
		if (masqueradeUserId) {
			const inNamespace = reg.namespaces.users?.some((ns) =>
				new RegExp(ns.regex).test(masqueradeUserId),
			);
			if (masqueradeUserId !== senderUser && !inNamespace) {
				throw forbidden("Application service cannot masquerade as this user");
			}
			asUserId = masqueradeUserId;
		} else {
			asUserId = senderUser;
		}

		// Auto-create the appservice user on first use (matches synapse): downstream
		// profile/membership lookups expect the account to exist.
		const existing = await storage.getUserById(asUserId as UserId);
		if (!existing) {
			const colon = asUserId.indexOf(":");
			const localpart = asUserId.slice(1, colon);
			const userServer = asUserId.slice(colon + 1);
			await storage.createUser({
				user_id: asUserId as UserId,
				localpart,
				server_name: userServer as ServerName,
				password_hash: "",
				account_type: "appservice",
				is_deactivated: false,
				created_at: Date.now(),
			});
		}

		req.userId = asUserId as UserId;
		req.accessToken = token;
		// Appservices have no real device. Use the ?device_id masquerade if given,
		// otherwise a stable per-appservice placeholder — req.deviceId must be
		// non-empty because it is a NOT NULL component of the txn-idempotency key
		// (txn_map.device_id), so leaving it undefined makes any AS event send
		// (e.g. jump-to-date historical imports with ?ts) 500.
		const masqueradeDeviceId = req.query.get("device_id");
		req.deviceId = (masqueradeDeviceId ??
			`_as_${reg.sender_localpart}`) as DeviceId;

		return next(req);
	};
