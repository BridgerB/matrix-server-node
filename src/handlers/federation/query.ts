import { notFound } from "../../errors.ts";
import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";
import type { RoomAlias, UserId } from "../../types/index.ts";
import { buildPublicRoomEntry } from "../directory.ts";

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
		const rooms = (
			await Promise.all(
				publicRoomIds.map((roomId) => buildPublicRoomEntry(storage, roomId)),
			)
		).filter(Boolean);

		return {
			status: 200,
			body: { chunk: rooms, total_room_count_estimate: rooms.length },
		};
	};

export const getQueryGeneric = (): Handler => async () => {
	throw notFound("Unknown query type");
};
