import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { badJson, forbidden, notFound } from "../errors.ts";
import { extractAccessToken } from "../middleware/auth.ts";
import { findAppserviceByToken } from "../appservice/registration.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { AppserviceRegistration } from "../types/appservice.ts";
import type { RoomId } from "../types/identifiers.ts";

/**
 * POST /_matrix/client/v1/appservice/:appserviceId/ping
 *
 * Pings an appservice to verify connectivity. Authenticated with as_token.
 * Makes a POST to the appservice's URL at /_matrix/app/v1/ping with the
 * hs_token. Returns { duration_ms } on success.
 */
export const postAppservicePing =
	(registrations: AppserviceRegistration[]): Handler =>
	async (req) => {
		const token = extractAccessToken(req);
		const reg = findAppserviceByToken(token, registrations);
		if (!reg) throw forbidden("Invalid as_token");

		const appserviceId = req.params.appserviceId!;
		if (reg.id !== appserviceId) {
			throw forbidden("as_token does not match appservice ID");
		}

		if (!reg.url) {
			throw notFound("Appservice has no URL configured");
		}

		const body = JSON.stringify({ transaction_id: `ping_${Date.now()}` });
		const start = Date.now();

		await new Promise<void>((resolve, reject) => {
			try {
				const url = new URL("/_matrix/app/v1/ping", reg.url);
				const reqFn =
					url.protocol === "https:" ? httpsRequest : httpRequest;

				const outReq = reqFn(
					url,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Content-Length": Buffer.byteLength(body).toString(),
							Authorization: `Bearer ${reg.hs_token}`,
						},
						timeout: 30_000,
					},
					(res) => {
						res.resume();
						if (res.statusCode && res.statusCode >= 400) {
							reject(
								new Error(
									`Appservice returned status ${res.statusCode}`,
								),
							);
						} else {
							resolve();
						}
					},
				);

				outReq.on("error", reject);
				outReq.on("timeout", () => {
					outReq.destroy();
					reject(new Error("Ping timed out"));
				});
				outReq.end(body);
			} catch (err) {
				reject(err);
			}
		});

		const durationMs = Date.now() - start;
		return { status: 200, body: { duration_ms: durationMs } };
	};

/**
 * PUT /_matrix/client/v3/directory/list/appservice/:networkId/:roomId
 *
 * Sets room visibility in the public room directory on behalf of an
 * appservice. Authenticated with as_token.
 */
export const putAppserviceDirectoryListRoom =
	(storage: Storage, registrations: AppserviceRegistration[]): Handler =>
	async (req) => {
		const token = extractAccessToken(req);
		const reg = findAppserviceByToken(token, registrations);
		if (!reg) throw forbidden("Invalid as_token");

		const roomId = req.params.roomId as RoomId;
		const body = (req.body ?? {}) as { visibility?: string };
		const visibility = body.visibility;

		if (visibility !== "public" && visibility !== "private") {
			throw badJson("visibility must be 'public' or 'private'");
		}

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		await storage.setRoomVisibility(roomId, visibility);
		return { status: 200, body: {} };
	};
