import { notFound } from "../errors.ts";
import { requireJoinedRoom } from "../events.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { EventId, RoomId } from "../types/index.ts";

export const postReportEvent =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const eventId = req.params.eventId as EventId;
		const userId = req.userId as string;

		await requireJoinedRoom(storage, roomId, userId);

		const entry = await storage.getEvent(eventId);
		if (!entry || entry.event.room_id !== roomId)
			throw notFound("Event not found");

		const body = (req.body ?? {}) as { score?: number; reason?: string };
		await storage.storeReport(userId, roomId, eventId, body.score, body.reason);

		return { status: 200, body: {} };
	};

export const postReportRoom =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const userId = req.userId as string;

		await requireJoinedRoom(storage, roomId, userId);

		const body = (req.body ?? {}) as { reason?: string };
		await storage.storeReport(
			userId,
			roomId,
			"" as EventId,
			undefined,
			body.reason,
		);

		return { status: 200, body: {} };
	};
