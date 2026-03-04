import { pduToClientEvent, requireJoinedRoom } from "../events.ts";
import { bundleAggregations } from "../relations.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { RoomId } from "../types/index.ts";

export const getThreads =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const userId = req.userId as string;

		await requireJoinedRoom(storage, roomId, userId);

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
