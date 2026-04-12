import { badJson, notFound } from "../errors.ts";
import { requireJoinedRoom } from "../events.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { EventId, RoomId, UserId } from "../types/index.ts";
import type { JsonObject } from "../types/json.ts";

export const postReadMarkers =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const userId = req.userId as UserId;
		const body = (req.body ?? {}) as Record<string, unknown>;

		await requireJoinedRoom(storage, roomId, userId);

		const fullyRead = body["m.fully_read"] as string | undefined;
		const read = body["m.read"] as string | undefined;
		const readPrivate = body["m.read.private"] as string | undefined;

		// Validate that referenced events belong to this room
		for (const eventId of [fullyRead, read, readPrivate]) {
			if (!eventId) continue;
			if (typeof eventId !== "string" || !eventId.startsWith("$")) {
				throw badJson("Invalid event ID");
			}
			const entry = await storage.getEvent(eventId as EventId);
			if (!entry || entry.event.room_id !== roomId) {
				throw notFound("Event not found in this room");
			}
		}

		if (fullyRead) {
			await storage.setRoomAccountData(userId, roomId, "m.fully_read", {
				event_id: fullyRead,
			} as JsonObject);
		}

		const now = Date.now();

		if (read) {
			await storage.setReceipt(
				roomId,
				userId,
				read as EventId,
				"m.read",
				now,
			);
		}

		if (readPrivate) {
			await storage.setReceipt(
				roomId,
				userId,
				readPrivate as EventId,
				"m.read.private",
				now,
			);
		}

		return { status: 200, body: {} };
	};
