import { notJoined, roomNotFound } from "../errors.ts";
import { getMembership, pduToClientEvent } from "../events.ts";
import { bundleAggregations } from "../relations.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { RoomId } from "../types/index.ts";

// =============================================================================
// GET /_matrix/client/v3/rooms/:roomId/threads
// =============================================================================

export function getThreads(storage: Storage): Handler {
	return async (req) => {
		const roomId = req.params.roomId as RoomId;
		const userId = req.userId as string;

		const room = await storage.getRoom(roomId);
		if (!room) throw roomNotFound();
		if (getMembership(room, userId) !== "join") throw notJoined();

		const include = (req.query.get("include") ?? "all") as
			| "all"
			| "participated";
		const limitStr = req.query.get("limit");
		const limit = Math.min(Math.max(parseInt(limitStr ?? "20", 10), 1), 100);
		const from = req.query.get("from") ?? undefined;

		const result = await storage.getThreadRoots(
			roomId,
			userId,
			include,
			limit,
			from,
		);
		const chunk = result.events.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);
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
