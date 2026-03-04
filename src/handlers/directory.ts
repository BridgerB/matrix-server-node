import { badJson, forbidden, notFound } from "../errors.ts";
import { getMembership, getUserPowerLevel } from "../events.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type {
	PublicRoomEntry,
	PublicRoomsResponse,
} from "../types/directory.ts";
import type { RoomAlias, RoomId } from "../types/index.ts";

const MAX_PUBLIC_ROOMS = 100;

// =============================================================================
// ALIAS MANAGEMENT
// =============================================================================

export function getDirectoryRoom(storage: Storage): Handler {
	return async (req) => {
		const roomAlias = req.params.roomAlias as RoomAlias;
		const result = await storage.getRoomByAlias(roomAlias);
		if (!result) throw notFound("Room alias not found");
		return {
			status: 200,
			body: { room_id: result.room_id, servers: result.servers },
		};
	};
}

export function putDirectoryRoom(
	storage: Storage,
	serverName: string,
): Handler {
	return async (req) => {
		const roomAlias = req.params.roomAlias as RoomAlias;
		const body = req.body as { room_id?: string };
		const roomId = body.room_id as RoomId | undefined;
		if (!roomId) throw badJson("Missing 'room_id'");

		// Check alias doesn't already exist
		const existing = await storage.getRoomByAlias(roomAlias);
		if (existing) throw badJson("Room alias already exists");

		// Check alias is local
		const aliasParts = roomAlias.split(":");
		const aliasDomain = aliasParts.slice(1).join(":");
		if (aliasDomain !== serverName) {
			throw badJson("Cannot create alias for remote server");
		}

		// Check user is in the room
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
}

export function deleteDirectoryRoom(
	storage: Storage,
	_serverName: string,
): Handler {
	return async (req) => {
		const roomAlias = req.params.roomAlias as RoomAlias;

		const result = await storage.getRoomByAlias(roomAlias);
		if (!result) throw notFound("Room alias not found");

		// Check permission: creator or room admin
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

		// If this was the canonical alias, update the state event
		const room = await storage.getRoom(result.room_id);
		if (room) {
			const canonicalEvent = room.state_events.get("m.room.canonical_alias\0");
			if (canonicalEvent) {
				const content = canonicalEvent.content as Record<string, unknown>;
				if (content.alias === roomAlias) {
					// Need to import buildEvent etc. to update state - but that creates
					// a circular concern. Instead, we'll leave the stale canonical alias
					// for now. A proper implementation would send a new state event.
				}
			}
		}

		return { status: 200, body: {} };
	};
}

// =============================================================================
// ROOM VISIBILITY
// =============================================================================

export function getDirectoryListRoom(storage: Storage): Handler {
	return async (req) => {
		const roomId = req.params.roomId as RoomId;
		const visibility = await storage.getRoomVisibility(roomId);
		return { status: 200, body: { visibility } };
	};
}

export function putDirectoryListRoom(storage: Storage): Handler {
	return async (req) => {
		const roomId = req.params.roomId as RoomId;
		const body = req.body as { visibility?: string };
		const visibility = body.visibility;
		if (visibility !== "public" && visibility !== "private") {
			throw badJson("visibility must be 'public' or 'private'");
		}

		// Check user has permission (PL for m.room.canonical_alias)
		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");
		const membership = getMembership(room, req.userId as string);
		if (membership !== "join") throw forbidden("Must be in the room");
		const userPl = getUserPowerLevel(req.userId as string, room);
		if (userPl < 50) throw forbidden("Insufficient power level");

		await storage.setRoomVisibility(roomId, visibility);
		return { status: 200, body: {} };
	};
}

// =============================================================================
// PUBLIC ROOMS
// =============================================================================

async function buildPublicRoomEntry(
	storage: Storage,
	roomId: RoomId,
): Promise<PublicRoomEntry | undefined> {
	const room = await storage.getRoom(roomId);
	if (!room) return undefined;

	// Count joined members
	let numJoined = 0;
	for (const [key, event] of room.state_events) {
		if (key.startsWith("m.room.member\0")) {
			const membership = (event.content as Record<string, unknown>).membership;
			if (membership === "join") numJoined++;
		}
	}

	// Get room metadata from state
	const nameEvent = room.state_events.get("m.room.name\0");
	const name = nameEvent
		? ((nameEvent.content as Record<string, unknown>).name as
				| string
				| undefined)
		: undefined;

	const topicEvent = room.state_events.get("m.room.topic\0");
	const topic = topicEvent
		? ((topicEvent.content as Record<string, unknown>).topic as
				| string
				| undefined)
		: undefined;

	const avatarEvent = room.state_events.get("m.room.avatar\0");
	const avatarUrl = avatarEvent
		? ((avatarEvent.content as Record<string, unknown>).url as
				| string
				| undefined)
		: undefined;

	const canonicalEvent = room.state_events.get("m.room.canonical_alias\0");
	const canonicalAlias = canonicalEvent
		? ((canonicalEvent.content as Record<string, unknown>).alias as
				| string
				| undefined)
		: undefined;

	const joinRulesEvent = room.state_events.get("m.room.join_rules\0");
	const joinRule = joinRulesEvent
		? ((joinRulesEvent.content as Record<string, unknown>).join_rule as
				| string
				| undefined)
		: undefined;

	const historyEvent = room.state_events.get("m.room.history_visibility\0");
	const historyVisibility = historyEvent
		? ((historyEvent.content as Record<string, unknown>).history_visibility as
				| string
				| undefined)
		: undefined;

	const guestEvent = room.state_events.get("m.room.guest_access\0");
	const guestAccess = guestEvent
		? ((guestEvent.content as Record<string, unknown>).guest_access as
				| string
				| undefined)
		: undefined;

	const createEvent = room.state_events.get("m.room.create\0");
	const roomType = createEvent
		? ((createEvent.content as Record<string, unknown>).type as
				| string
				| undefined)
		: undefined;

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
}

export function getPublicRooms(storage: Storage): Handler {
	return async (req) => {
		const limit = Math.min(
			parseInt(req.query.get("limit") ?? "20", 10),
			MAX_PUBLIC_ROOMS,
		);
		const since = req.query.get("since") ?? undefined;

		const response = await buildPublicRoomsResponse(storage, limit, since);
		return { status: 200, body: response };
	};
}

export function postPublicRooms(storage: Storage): Handler {
	return async (req) => {
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
}

async function buildPublicRoomsResponse(
	storage: Storage,
	limit: number,
	since?: string,
	searchTerm?: string,
): Promise<PublicRoomsResponse> {
	const publicRoomIds = await storage.getPublicRoomIds();

	// Build entries
	const allEntries: PublicRoomEntry[] = [];
	for (const roomId of publicRoomIds) {
		const entry = await buildPublicRoomEntry(storage, roomId);
		if (!entry) continue;

		// Filter by search term
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

	// Sort by member count descending
	allEntries.sort((a, b) => b.num_joined_members - a.num_joined_members);

	const total = allEntries.length;

	// Pagination
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
}
