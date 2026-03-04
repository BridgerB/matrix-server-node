import { badJson, forbidden, notFound } from "../errors.ts";
import {
	countJoinedMembers,
	getMembership,
	getStateContent,
	getUserPowerLevel,
} from "../events.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type {
	PublicRoomEntry,
	PublicRoomsResponse,
} from "../types/directory.ts";
import type { RoomAlias, RoomId } from "../types/index.ts";

const MAX_PUBLIC_ROOMS = 100;

export const buildPublicRoomEntry = async (
	storage: Storage,
	roomId: RoomId,
): Promise<PublicRoomEntry | undefined> => {
	const room = await storage.getRoom(roomId);
	if (!room) return undefined;

	const numJoined = countJoinedMembers(room.state_events);

	const name = getStateContent(room.state_events, "m.room.name\0", "name");
	const topic = getStateContent(room.state_events, "m.room.topic\0", "topic");
	const avatarUrl = getStateContent(
		room.state_events,
		"m.room.avatar\0",
		"url",
	);
	const canonicalAlias = getStateContent(
		room.state_events,
		"m.room.canonical_alias\0",
		"alias",
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

	const aliases = await storage.getAliasesForRoom(roomId);

	const entry: PublicRoomEntry = {
		room_id: roomId,
		num_joined_members: numJoined,
		world_readable: historyVisibility === "world_readable",
		guest_can_join: guestAccess === "can_join",
	};

	if (name) entry.name = name;
	if (topic) entry.topic = topic;
	if (avatarUrl) entry.avatar_url = avatarUrl;
	if (canonicalAlias) entry.canonical_alias = canonicalAlias;
	if (aliases.length > 0) entry.aliases = aliases;
	if (joinRule) entry.join_rule = joinRule;
	if (roomType) entry.room_type = roomType;

	return entry;
};

const buildPublicRoomsResponse = async (
	storage: Storage,
	limit: number,
	since?: string,
	searchTerm?: string,
): Promise<PublicRoomsResponse> => {
	const publicRoomIds = await storage.getPublicRoomIds();

	const allEntries: PublicRoomEntry[] = [];
	for (const roomId of publicRoomIds) {
		const entry = await buildPublicRoomEntry(storage, roomId);
		if (!entry) continue;

		if (searchTerm) {
			const nameMatch = entry.name?.toLowerCase().includes(searchTerm);
			const topicMatch = entry.topic?.toLowerCase().includes(searchTerm);
			const aliasMatch = entry.canonical_alias
				?.toLowerCase()
				.includes(searchTerm);
			if (!nameMatch && !topicMatch && !aliasMatch) continue;
		}

		allEntries.push(entry);
	}

	allEntries.sort((a, b) => b.num_joined_members - a.num_joined_members);

	const total = allEntries.length;
	const offset = since
		? parseInt(Buffer.from(since, "base64url").toString(), 10)
		: 0;
	const sliced = allEntries.slice(offset, offset + limit);

	const nextOffset = offset + limit;
	const nextBatch =
		nextOffset < total
			? Buffer.from(String(nextOffset)).toString("base64url")
			: undefined;
	const prevBatch =
		offset > 0
			? Buffer.from(String(Math.max(0, offset - limit))).toString("base64url")
			: undefined;

	return {
		chunk: sliced,
		next_batch: nextBatch,
		prev_batch: prevBatch,
		total_room_count_estimate: total,
	};
};

export const getDirectoryRoom =
	(storage: Storage): Handler =>
	async (req) => {
		const roomAlias = req.params.roomAlias as RoomAlias;
		const result = await storage.getRoomByAlias(roomAlias);
		if (!result) throw notFound("Room alias not found");
		return {
			status: 200,
			body: { room_id: result.room_id, servers: result.servers },
		};
	};

export const putDirectoryRoom =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const roomAlias = req.params.roomAlias as RoomAlias;
		const body = req.body as { room_id?: string };
		const roomId = body.room_id as RoomId | undefined;
		if (!roomId) throw badJson("Missing 'room_id'");

		const existing = await storage.getRoomByAlias(roomAlias);
		if (existing) throw badJson("Room alias already exists");

		const aliasDomain = roomAlias.split(":").slice(1).join(":");
		if (aliasDomain !== serverName)
			throw badJson("Cannot create alias for remote server");

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");
		const membership = getMembership(room, req.userId as string);
		if (membership !== "join")
			throw forbidden("Must be in the room to create an alias");

		await storage.createRoomAlias(
			roomAlias,
			roomId,
			[serverName],
			req.userId as string,
		);
		return { status: 200, body: {} };
	};

export const deleteDirectoryRoom =
	(storage: Storage, _serverName: string): Handler =>
	async (req) => {
		const roomAlias = req.params.roomAlias as RoomAlias;

		const result = await storage.getRoomByAlias(roomAlias);
		if (!result) throw notFound("Room alias not found");

		const creator = await storage.getAliasCreator(roomAlias);
		if (creator !== req.userId) {
			const room = await storage.getRoom(result.room_id);
			if (room) {
				const userPl = getUserPowerLevel(req.userId as string, room);
				const requiredPl = 50; // PL for m.room.canonical_alias
				if (userPl < requiredPl) {
					throw forbidden(
						"Must be alias creator or room admin to delete alias",
					);
				}
			} else {
				throw forbidden("Must be alias creator to delete alias");
			}
		}

		await storage.deleteRoomAlias(roomAlias);
		return { status: 200, body: {} };
	};

export const getDirectoryListRoom =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const visibility = await storage.getRoomVisibility(roomId);
		return { status: 200, body: { visibility } };
	};

export const putDirectoryListRoom =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const body = req.body as { visibility?: string };
		const visibility = body.visibility;
		if (visibility !== "public" && visibility !== "private")
			throw badJson("visibility must be 'public' or 'private'");

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");
		const membership = getMembership(room, req.userId as string);
		if (membership !== "join") throw forbidden("Must be in the room");
		const userPl = getUserPowerLevel(req.userId as string, room);
		if (userPl < 50) throw forbidden("Insufficient power level");

		await storage.setRoomVisibility(roomId, visibility);
		return { status: 200, body: {} };
	};

export const getPublicRooms =
	(storage: Storage): Handler =>
	async (req) => {
		const limit = Math.min(
			parseInt(req.query.get("limit") ?? "20", 10),
			MAX_PUBLIC_ROOMS,
		);
		const since = req.query.get("since") ?? undefined;

		const response = await buildPublicRoomsResponse(storage, limit, since);
		return { status: 200, body: response };
	};

export const postPublicRooms =
	(storage: Storage): Handler =>
	async (req) => {
		const body = (req.body ?? {}) as {
			limit?: number;
			since?: string;
			filter?: { generic_search_term?: string };
		};

		const limit = Math.min(body.limit ?? 20, MAX_PUBLIC_ROOMS);
		const since = body.since;
		const searchTerm = body.filter?.generic_search_term?.toLowerCase();

		const response = await buildPublicRoomsResponse(
			storage,
			limit,
			since,
			searchTerm,
		);
		return { status: 200, body: response };
	};
