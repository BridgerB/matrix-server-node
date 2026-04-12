import { forbidden, missingToken } from "../errors.ts";
import { extractAccessToken } from "./auth.ts";
import { findAppserviceByToken } from "../appservice/registration.ts";
import type { AppserviceRegistration } from "../types/appservice.ts";
import type { Middleware } from "../router.ts";
import type { DeviceId, UserId } from "../types/identifiers.ts";

/**
 * Middleware that authenticates requests from application services.
 *
 * Accepts the as_token via `Authorization: Bearer <as_token>` header or the
 * `access_token` query parameter (same extraction logic as normal auth).
 *
 * When `user_id` query parameter is present, the appservice is masquerading
 * as that user; req.userId is set accordingly. Otherwise req.userId is set
 * to the appservice's sender_localpart-based user ID.
 */
export const requireAppserviceAuth =
	(
		registrations: AppserviceRegistration[],
		serverName: string,
	): Middleware =>
	async (req, next) => {
		const token = extractAccessToken(req);

		const reg = findAppserviceByToken(token, registrations);
		if (!reg) throw missingToken("Unrecognised as_token");

		const masqueradeUserId = req.query.get("user_id");
		if (masqueradeUserId) {
			// Verify the user is within the appservice's user namespace
			// or is the appservice's sender_localpart user
			const senderUser = `@${reg.sender_localpart}:${serverName}`;
			const inNamespace = reg.namespaces.users?.some((ns) =>
				new RegExp(ns.regex).test(masqueradeUserId),
			);

			if (masqueradeUserId !== senderUser && !inNamespace) {
				throw forbidden(
					"Application service cannot masquerade as this user",
				);
			}

			req.userId = masqueradeUserId as UserId;
		} else {
			req.userId = `@${reg.sender_localpart}:${serverName}` as UserId;
		}

		req.accessToken = token;

		// v1.17: Application service device masquerading via device_id query param
		const masqueradeDeviceId = req.query.get("device_id");
		if (masqueradeDeviceId) {
			req.deviceId = masqueradeDeviceId as DeviceId;
		}

		return next(req);
	};
