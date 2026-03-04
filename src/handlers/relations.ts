import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import { pduToClientEvent, getMembership } from "../events.ts";
import { notFound, roomNotFound, notJoined } from "../errors.ts";
import { bundleAggregations } from "../relations.ts";

// =============================================================================
// GET /rooms/:roomId/relations/:eventId(/:relType(/:eventType))
// =============================================================================

export function getRelations(storage: Storage): Handler {
	return async (req) => {
		const roomId = req.params["roomId"]!;
		const eventId = req.params["eventId"]!;
		const relType = req.params["relType"];
		const eventType = req.params["eventType"];
		const userId = req.userId!;

		const room = await storage.getRoom(roomId);
		if (!room) throw roomNotFound();
		if (getMembership(room, userId) !== "join") throw notJoined();

		// Verify target event exists
		const target = await storage.getEvent(eventId);
		if (!target || target.event.room_id !== roomId)
			throw notFound("Event not found");

		const limitStr = req.query.get("limit");
		const limit = Math.min(Math.max(parseInt(limitStr ?? "50", 10), 1), 100);
		const from = req.query.get("from") ?? undefined;
		const dir = (req.query.get("dir") ?? "b") as "b" | "f";

		const result = await storage.getRelatedEvents(
			roomId,
			eventId,
			relType,
			eventType,
			limit,
			from,
			dir,
		);
		const chunk = result.events.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);

		// Bundle aggregations on the related events themselves
		await bundleAggregations(storage, chunk, userId);

		return {
			status: 200,
			body: {
				chunk,
				next_batch: result.nextBatch,
			},
		};
	};
}
