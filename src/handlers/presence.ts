import { forbidden } from "../errors.ts";
import type { FederationClient } from "../federation/client.ts";
import { fanoutEdu } from "../federation/outbound.ts";
import type { Handler } from "../router.ts";
import type { SigningKey } from "../signing.ts";
import type { Storage } from "../storage/interface.ts";
import type { PresenceState } from "../types/ephemeral.ts";
import type { ServerName, UserId } from "../types/index.ts";

export const getPresence =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;

		const data = await storage.getPresence(userId);
		if (!data) {
			return {
				status: 200,
				body: { presence: "offline" as PresenceState },
			};
		}

		const result: Record<string, unknown> = { presence: data.presence };
		if (data.status_msg) result.status_msg = data.status_msg;
		if (data.last_active_ts) {
			result.last_active_ago = Date.now() - data.last_active_ts;
		}
		return { status: 200, body: result };
	};

export const putPresence =
	(
		storage: Storage,
		serverName?: ServerName,
		signingKey?: SigningKey,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const userId = req.params.userId as UserId;
		if (req.userId !== userId)
			throw forbidden("Cannot set another user's presence");

		const body = req.body as Record<string, unknown>;
		const presence = body.presence as PresenceState;
		const statusMsg = body.status_msg as string | undefined;

		await storage.setPresence(userId, presence, statusMsg);

		// Federate the presence update to every remote server that shares a room
		// with this user. Synapse's m.presence EDU wraps per-user updates in a
		// top-level `push` array (server-server-api spec).
		if (serverName && signingKey && federationClient) {
			void (async () => {
				const roomIds = await storage.getRoomsForUser(userId);
				if (roomIds.length === 0) return;

				const update: {
					user_id: UserId;
					presence: PresenceState;
					status_msg?: string;
					last_active_ago?: number;
					currently_active?: boolean;
				} = { user_id: userId, presence };
				if (statusMsg !== undefined) update.status_msg = statusMsg;

				const stored = await storage.getPresence(userId);
				if (stored?.last_active_ts) {
					update.last_active_ago = Date.now() - stored.last_active_ts;
				}
				if (presence === "online") update.currently_active = true;

				await fanoutEdu(
					storage,
					serverName,
					signingKey,
					federationClient,
					roomIds,
					{
						edu_type: "m.presence",
						content: { push: [update] },
					},
				);
			})().catch(() => {});
		}

		return { status: 200, body: {} };
	};
