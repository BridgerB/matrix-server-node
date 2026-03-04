import { notFound, notJoined, roomNotFound } from "../errors.ts";
import { getMembership } from "../events.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { EventId, RoomId } from "../types/index.ts";

// =============================================================================
// POST /_matrix/client/v3/rooms/:roomId/report/:eventId
// =============================================================================

export function postReportEvent(storage: Storage): Handler {
	return async (req) => {
		const roomId = req.params.roomId as RoomId;
		const eventId = req.params.eventId as EventId;
		const userId = req.userId as string;

		const room = await storage.getRoom(roomId);
		if (!room) throw roomNotFound();
		if (getMembership(room, userId) !== "join") throw notJoined();

		const entry = await storage.getEvent(eventId);
		if (!entry || entry.event.room_id !== roomId)
			throw notFound("Event not found");

		const body = (req.body ?? {}) as { score?: number; reason?: string };
		await storage.storeReport(userId, roomId, eventId, body.score, body.reason);

		return { status: 200, body: {} };
	};
}
