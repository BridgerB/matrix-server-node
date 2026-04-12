import { notFound } from "../errors.ts";
import {
	countJoinedMembers,
	getMembership,
	getStateContent,
} from "../events.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { RoomAlias, RoomId } from "../types/index.ts";

export const getRoomSummary =
	(storage: Storage): Handler =>
	async (req) => {
		const roomIdOrAlias = req.params.roomIdOrAlias as string;

		let roomId: RoomId;
		if (roomIdOrAlias.startsWith("#")) {
			const result = await storage.getRoomByAlias(
				roomIdOrAlias as RoomAlias,
			);
			if (!result) throw notFound("Room alias not found");
			roomId = result.room_id;
		} else {
			roomId = roomIdOrAlias as RoomId;
		}

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		const numJoined = countJoinedMembers(room.state_events);

		const name = getStateContent(room.state_events, "m.room.name\0", "name");
		const topic = getStateContent(
			room.state_events,
			"m.room.topic\0",
			"topic",
		);
		const avatarUrl = getStateContent(
			room.state_events,
			"m.room.avatar\0",
			"url",
		);
		const joinRule = getStateContent(
			room.state_events,
			"m.room.join_rules\0",
			"join_rule",
		);
		const historyVisibility = getStateContent(
			room.state_events,
			"m.room.history_visibility\0",
			"history_visibility",
		);
		const guestAccess = getStateContent(
			room.state_events,
			"m.room.guest_access\0",
			"guest_access",
		);
		const roomType = getStateContent(
			room.state_events,
			"m.room.create\0",
			"type",
		);

		const userId = req.userId as string;
		const membership = getMembership(room, userId);

		const body: Record<string, unknown> = {
			room_id: roomId,
			num_joined_members: numJoined,
			world_readable: historyVisibility === "world_readable",
			guest_can_join: guestAccess === "can_join",
		};

		if (name) body.name = name;
		if (topic) body.topic = topic;
		if (avatarUrl) body.avatar_url = avatarUrl;
		if (joinRule) body.join_rule = joinRule;
		if (roomType) body.room_type = roomType;
		if (membership) body.membership = membership;

		return { status: 200, body };
	};
