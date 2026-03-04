import { notFound } from "../../errors.ts";
import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";
import type { RoomAlias, UserId } from "../../types/index.ts";

export const getQueryProfile =
	(storage: Storage): Handler =>
	async (req) => {
		const userId = req.query.get("user_id") as UserId | null;
		if (!userId) throw notFound("Missing user_id");

		const profile = await storage.getProfile(userId);
		if (!profile) throw notFound("User not found");

		const field = req.query.get("field");
		if (field === "displayname")
			return { status: 200, body: { displayname: profile.displayname } };
		if (field === "avatar_url")
			return { status: 200, body: { avatar_url: profile.avatar_url } };

		return {
			status: 200,
			body: {
				displayname: profile.displayname,
				avatar_url: profile.avatar_url,
			},
		};
	};

export const getQueryDirectory =
	(storage: Storage): Handler =>
	async (req) => {
		const roomAlias = req.query.get("room_alias") as RoomAlias | null;
		if (!roomAlias) throw notFound("Missing room_alias");

		const result = await storage.getRoomByAlias(roomAlias);
		if (!result) throw notFound("Room alias not found");

		return {
			status: 200,
			body: {
				room_id: result.room_id,
				servers: result.servers,
			},
		};
	};

export const getFederationPublicRooms =
	(storage: Storage): Handler =>
	async (_req) => {
		const publicRoomIds = await storage.getPublicRoomIds();
		const rooms: unknown[] = [];

		for (const roomId of publicRoomIds) {
			const room = await storage.getRoom(roomId);
			if (!room) continue;

			const nameEvent = room.state_events.get("m.room.name\0");
			const topicEvent = room.state_events.get("m.room.topic\0");
			const aliasEvent = room.state_events.get("m.room.canonical_alias\0");
			const avatarEvent = room.state_events.get("m.room.avatar\0");

			const memberCount = [...room.state_events.entries()].filter(
				([key, event]) =>
					key.startsWith("m.room.member\0") &&
					(event.content as Record<string, unknown>).membership === "join",
			).length;

			rooms.push({
				room_id: roomId,
				name: nameEvent
					? (nameEvent.content as Record<string, unknown>).name
					: undefined,
				topic: topicEvent
					? (topicEvent.content as Record<string, unknown>).topic
					: undefined,
				canonical_alias: aliasEvent
					? (aliasEvent.content as Record<string, unknown>).alias
					: undefined,
				avatar_url: avatarEvent
					? (avatarEvent.content as Record<string, unknown>).url
					: undefined,
				num_joined_members: memberCount,
				world_readable: false,
				guest_can_join: false,
			});
		}

		return {
			status: 200,
			body: { chunk: rooms, total_room_count_estimate: rooms.length },
		};
	};
