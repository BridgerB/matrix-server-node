import { generateRoomId } from "../crypto.ts";
import { badJson, forbidden, notJoined, roomNotFound } from "../errors.ts";
import {
	buildEvent,
	checkEventAuth,
	computeEventId,
	type EventContext,
	getMembership,
	getUserPowerLevel,
	selectAuthEvents,
	sendStateEvent,
} from "../events.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { EventId, RoomId } from "../types/index.ts";
import type { RoomState } from "../types/internal.ts";
import type { RoomVersion } from "../types/room-versions.ts";
import type { RoomPowerLevelsContent } from "../types/state-events.ts";

const STATE_TO_COPY = [
	"m.room.join_rules",
	"m.room.history_visibility",
	"m.room.guest_access",
	"m.room.power_levels",
	"m.room.name",
	"m.room.topic",
	"m.room.avatar",
	"m.room.encryption",
	"m.room.server_acl",
	"m.room.pinned_events",
];

export const postRoomUpgrade =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const oldRoomId = req.params.roomId as RoomId;
		const userId = req.userId as string;
		const body = (req.body ?? {}) as { new_version?: string };

		if (!body.new_version) throw badJson("Missing new_version");

		const oldRoom = await storage.getRoom(oldRoomId);
		if (!oldRoom) throw roomNotFound();
		if (getMembership(oldRoom, userId) !== "join") throw notJoined();

		const senderPl = getUserPowerLevel(userId, oldRoom);
		const plEvent = oldRoom.state_events.get("m.room.power_levels\0");
		const pl = plEvent
			? (plEvent.content as unknown as RoomPowerLevelsContent)
			: undefined;
		const tombstonePl = pl?.events?.["m.room.tombstone"] ?? 100;
		if (senderPl < tombstonePl) {
			throw forbidden(
				`Insufficient power level: need ${tombstonePl}, have ${senderPl}`,
			);
		}

		const newRoomId = generateRoomId(serverName) as RoomId;
		const newRoomState: RoomState = {
			room_id: newRoomId,
			room_version: body.new_version as RoomVersion,
			state_events: new Map(),
			depth: 0,
			forward_extremities: [],
		};
		await storage.createRoom(newRoomState);

		const ctx: EventContext = {
			roomState: newRoomState,
			depth: 0,
			prevEvents: [],
		};

		const lastCreateEvent = oldRoom.state_events.get("m.room.create\0");
		const lastCreateEventId = lastCreateEvent
			? computeEventId(lastCreateEvent)
			: ("" as EventId);

		await sendStateEvent(
			storage,
			serverName,
			ctx,
			userId,
			"m.room.create",
			"",
			{
				room_version: body.new_version,
				predecessor: {
					room_id: oldRoomId,
					event_id: lastCreateEventId,
				},
			},
		);

		await sendStateEvent(
			storage,
			serverName,
			ctx,
			userId,
			"m.room.member",
			userId,
			{
				membership: "join",
			},
		);

		for (const stateType of STATE_TO_COPY) {
			const oldEvent = oldRoom.state_events.get(`${stateType}\0`);
			if (!oldEvent) continue;

			await sendStateEvent(
				storage,
				serverName,
				ctx,
				userId,
				stateType,
				oldEvent.state_key ?? "",
				{ ...oldEvent.content },
			);
		}

		const tombstoneAuthEvents = selectAuthEvents(
			"m.room.tombstone",
			"",
			oldRoom,
			userId,
		);
		const { event: tombstoneEvent, eventId: tombstoneEventId } = buildEvent({
			roomId: oldRoomId,
			sender: userId,
			type: "m.room.tombstone",
			content: {
				body: "This room has been replaced",
				replacement_room: newRoomId,
			},
			stateKey: "",
			depth: oldRoom.depth,
			prevEvents: [...oldRoom.forward_extremities],
			authEvents: tombstoneAuthEvents,
			serverName,
		});

		checkEventAuth(tombstoneEvent, tombstoneEventId, oldRoom);
		await storage.setStateEvent(oldRoomId, tombstoneEvent, tombstoneEventId);
		oldRoom.depth++;
		oldRoom.forward_extremities = [tombstoneEventId];

		return {
			status: 200,
			body: { replacement_room: newRoomId },
		};
	};
