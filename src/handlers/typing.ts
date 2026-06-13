import { forbidden } from "../errors.ts";
import type { FederationClient } from "../federation/client.ts";
import { fanoutEdu } from "../federation/outbound.ts";
import type { Handler } from "../router.ts";
import type { SigningKey } from "../signing.ts";
import type { Storage } from "../storage/interface.ts";
import type { RoomId, ServerName, UserId } from "../types/index.ts";

export const putTyping =
	(
		storage: Storage,
		serverName?: ServerName,
		signingKey?: SigningKey,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const userId = req.params.userId as UserId;

		if (req.userId !== userId)
			throw forbidden("Cannot set typing for another user");

		const body = req.body as Record<string, unknown>;
		const typing = body.typing === true;
		const timeout = typeof body.timeout === "number" ? body.timeout : undefined;

		await storage.setTyping(roomId, userId, typing, timeout);

		// Federate the typing notification to remote servers sharing the room.
		if (serverName && signingKey && federationClient) {
			void fanoutEdu(storage, serverName, signingKey, federationClient, roomId, {
				edu_type: "m.typing",
				content: { room_id: roomId, user_id: userId, typing },
			}).catch(() => {});
		}

		return { status: 200, body: {} };
	};
