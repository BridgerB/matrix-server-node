import { notFound, notJoined, roomNotFound } from "../errors.ts";
import { getMembership, pduToClientEvent } from "../events.ts";
import { bundleAggregations } from "../relations.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";

export const getRelations =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as string;
		const eventId = req.params.eventId as string;
		const relType = req.params.relType;
		const eventType = req.params.eventType;
		const userId = req.userId as string;

		const room = await storage.getRoom(roomId);
		if (!room) throw roomNotFound();
		if (getMembership(room, userId) !== "join") throw notJoined();

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

		await bundleAggregations(storage, chunk, userId);

		return {
			status: 200,
			body: {
				chunk,
				next_batch: result.nextBatch,
			},
		};
	};
