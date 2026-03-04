import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";
import type { UserId, RoomAlias } from "../../types/index.ts";
import { notFound } from "../../errors.ts";

// =============================================================================
// GET /_matrix/federation/v1/query/profile
// =============================================================================

export function getQueryProfile(storage: Storage): Handler {
	return async (req) => {
		const userId = req.query.get("user_id") as UserId | null;
		if (!userId) throw notFound("Missing user_id");

		const profile = await storage.getProfile(userId);
		if (!profile) throw notFound("User not found");

		const field = req.query.get("field");
		if (field === "displayname") {
			return { status: 200, body: { displayname: profile.displayname } };
		}
		if (field === "avatar_url") {
			return { status: 200, body: { avatar_url: profile.avatar_url } };
		}

		return {
			status: 200,
			body: {
				displayname: profile.displayname,
				avatar_url: profile.avatar_url,
			},
		};
	};
}

// =============================================================================
// GET /_matrix/federation/v1/query/directory
// =============================================================================

export function getQueryDirectory(storage: Storage): Handler {
	return async (req) => {
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
}

// =============================================================================
// GET /_matrix/federation/v1/publicRooms
// =============================================================================

export function getFederationPublicRooms(storage: Storage): Handler {
	return async (_req) => {
		const publicRoomIds = await storage.getPublicRoomIds();
		const rooms: unknown[] = [];

		for (const roomId of publicRoomIds) {
			const room = await storage.getRoom(roomId);
			if (!room) continue;

			const nameEvent = room.state_events.get("m.room.name\0");
			const topicEvent = room.state_events.get("m.room.topic\0");
			const aliasEvent = room.state_events.get("m.room.canonical_alias\0");
			const avatarEvent = room.state_events.get("m.room.avatar\0");

			let memberCount = 0;
			for (const [key, event] of room.state_events) {
				if (key.startsWith("m.room.member\0")) {
					if (
						(event.content as Record<string, unknown>)["membership"] === "join"
					)
						memberCount++;
				}
			}

			rooms.push({
				room_id: roomId,
				name: nameEvent
					? (nameEvent.content as Record<string, unknown>)["name"]
					: undefined,
				topic: topicEvent
					? (topicEvent.content as Record<string, unknown>)["topic"]
					: undefined,
				canonical_alias: aliasEvent
					? (aliasEvent.content as Record<string, unknown>)["alias"]
					: undefined,
				avatar_url: avatarEvent
					? (avatarEvent.content as Record<string, unknown>)["url"]
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
}
