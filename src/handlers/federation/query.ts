import { notFound } from "../../errors.ts";
import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";
import type { RoomAlias, Timestamp, UserId } from "../../types/index.ts";
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

export const postFederationPublicRooms =
	(storage: Storage): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as {
			limit?: number;
			since?: string;
			filter?: { generic_search_term?: string };
		};

		const limit = Math.min(body.limit ?? 100, 100);
		const publicRoomIds = await storage.getPublicRoomIds();
		const allRooms = (
			await Promise.all(
				publicRoomIds.map((roomId) => buildPublicRoomEntry(storage, roomId)),
			)
		).filter(Boolean);

		const searchTerm = body.filter?.generic_search_term?.toLowerCase();
		const filtered = searchTerm
			? allRooms.filter((r) => {
					if (!r) return false;
					return (
						r.name?.toLowerCase().includes(searchTerm) ||
						r.topic?.toLowerCase().includes(searchTerm)
					);
				})
			: allRooms;

		const startIdx = body.since ? parseInt(body.since, 10) : 0;
		const chunk = filtered.slice(startIdx, startIdx + limit);
		const nextBatch =
			startIdx + limit < filtered.length
				? String(startIdx + limit)
				: undefined;

		return {
			status: 200,
			body: {
				chunk,
				next_batch: nextBatch,
				total_room_count_estimate: filtered.length,
			},
		};
	};

export const getFederationVersion = (): Handler => () => ({
	status: 200,
	body: {
		server: {
			name: "matrix-server-node",
			version: "0.0.1",
		},
	},
});

export const getQueryGeneric = (): Handler => (_req) => ({
	status: 200,
	body: {},
});

export const getFederationOpenIdUserinfo =
	(storage: Storage): Handler =>
	async (req) => {
		const accessToken = req.query.get("access_token");
		if (!accessToken) throw notFound("Missing access_token");

		const result = await storage.getOpenIdToken(accessToken);
		if (!result) throw notFound("Token not found");

		if (result.expiresAt <= (Date.now() as Timestamp))
			throw notFound("Token expired");

		return {
			status: 200,
			body: { sub: result.userId },
		};
	};
