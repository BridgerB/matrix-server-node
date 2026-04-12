import { pduToClientEvent, requireJoinedRoom } from "../events.ts";
import { bundleAggregations } from "../relations.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { RoomId, UserId } from "../types/index.ts";

export const getRoomInitialSync =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const userId = req.userId as UserId;

		await requireJoinedRoom(storage, roomId, userId);

		// Get current state
		const stateEntries = await storage.getAllState(roomId);
		const state = stateEntries.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);

		// Get recent messages
		const result = await storage.getEventsByRoom(roomId, 20, undefined, "b");
		const chunk = result.events.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);

		await bundleAggregations(storage, chunk, userId);

		return {
			status: 200,
			body: {
				room_id: roomId,
				state,
				messages: {
					chunk,
					start: String(result.end ?? 0),
					end: "0",
				},
				membership: "join",
			},
		};
	};
