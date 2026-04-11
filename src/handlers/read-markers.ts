import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { EventId, RoomId, UserId } from "../types/index.ts";
import type { JsonObject } from "../types/json.ts";

export const postReadMarkers =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const userId = req.userId as UserId;
		const body = (req.body ?? {}) as Record<string, string>;

		const fullyRead = body["m.fully_read"] as EventId | undefined;
		const read = body["m.read"] as EventId | undefined;
		const readPrivate = body["m.read.private"] as EventId | undefined;

		if (fullyRead) {
			await storage.setRoomAccountData(userId, roomId, "m.fully_read", {
				event_id: fullyRead,
			} as JsonObject);
		}

		const now = Date.now();

		if (read) {
			await storage.setReceipt(roomId, userId, read, "m.read", now);
		}

		if (readPrivate) {
			await storage.setReceipt(
				roomId,
				userId,
				readPrivate,
				"m.read.private",
				now,
			);
		}

		return { status: 200, body: {} };
	};
