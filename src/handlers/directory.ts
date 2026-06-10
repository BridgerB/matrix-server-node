import { badJson, forbidden, notFound } from "../errors.ts";
import {
	buildEvent,
	checkEventAuth,
	countJoinedMembers,
	getMembership,
	getStateContent,
	getUserPowerLevel,
	requireJoinedRoom,
	selectAuthEvents,
} from "../events.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type {
	PublicRoomEntry,
	PublicRoomsResponse,
} from "../types/directory.ts";
import type { FederationClient } from "../federation/client.ts";
import type { RoomAlias, RoomId, ServerName, UserId } from "../types/index.ts";
import type { JsonObject } from "../types/json.ts";

const MAX_PUBLIC_ROOMS = 100;

export const buildPublicRoomEntry = async (
	storage: Storage,
	roomId: RoomId,
): Promise<PublicRoomEntry | undefined> => {
	const room = await storage.getRoom(roomId);
	if (!room) return undefined;

	const numJoined = countJoinedMembers(room.state_events);

	const name = getStateContent(room.state_events, "m.room.name\x1f", "name");
	const topic = getStateContent(room.state_events, "m.room.topic\x1f", "topic");
	const avatarUrl = getStateContent(
		room.state_events,
		"m.room.avatar\x1f",
		"url",
	);
	const canonicalAlias = getStateContent(
		room.state_events,
		"m.room.canonical_alias\x1f",
		"alias",
	);
	const joinRule = getStateContent(
		room.state_events,
		"m.room.join_rules\x1f",
		"join_rule",
	);
	const historyVisibility = getStateContent(
		room.state_events,
		"m.room.history_visibility\x1f",
		"history_visibility",
	);
	const guestAccess = getStateContent(
		room.state_events,
		"m.room.guest_access\x1f",
		"guest_access",
	);
	const roomType = getStateContent(
		room.state_events,
		"m.room.create\x1f",
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
	(
		storage: Storage,
		serverName?: string,
		federationClient?: FederationClient,
	): Handler =>
	async (req) => {
		const roomAlias = req.params.roomAlias as RoomAlias;

		// Remote alias: resolve it over federation.
		const aliasDomain = roomAlias.slice(roomAlias.indexOf(":") + 1);
		if (serverName && aliasDomain !== serverName && federationClient) {
			const { status, body } = await federationClient.request(
				aliasDomain as ServerName,
				"GET",
				`/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(roomAlias)}`,
			);
			if (status !== 200) throw notFound("Room alias not found");
			const r = body as { room_id?: string; servers?: string[] };
			return {
				status: 200,
				body: { room_id: r.room_id, servers: r.servers ?? [aliasDomain] },
			};
		}

		const result = await storage.getRoomByAlias(roomAlias);
		if (!result) throw notFound("Room alias not found");
		// Advertise the room's current resident servers (members + a partial-state
		// room's recorded servers_in_room), not just whoever holds the alias, so a
		// client can actually join via them. (TestPartialStateJoin room-aliases.)
		const roomServers = await storage.getServersInRoom(
			result.room_id as RoomId,
		);
		const servers = [
			...new Set([...(result.servers ?? []), ...roomServers]),
		];
		return {
			status: 200,
			body: { room_id: result.room_id, servers },
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
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const roomAlias = req.params.roomAlias as RoomAlias;
		const userId = req.userId as UserId;

		const result = await storage.getRoomByAlias(roomAlias);
		if (!result) throw notFound("Room alias not found");

		const room = await storage.getRoom(result.room_id);

		const creator = await storage.getAliasCreator(roomAlias);
		if (creator !== userId) {
			if (room) {
				const userPl = getUserPowerLevel(userId, room);
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

		// If this alias was referenced by the room's m.room.canonical_alias state
		// event (as `alias` or within `alt_aliases`), emit an updated
		// m.room.canonical_alias event with the deleted alias removed. This keeps
		// canonical alias state consistent (and is observable via /sync).
		if (room) {
			const canonical = room.state_events.get("m.room.canonical_alias\x1f");
			if (canonical) {
				const content = (canonical.content ?? {}) as {
					alias?: string;
					alt_aliases?: string[];
				};
				const referencesAlias =
					content.alias === roomAlias ||
					(Array.isArray(content.alt_aliases) &&
						content.alt_aliases.includes(roomAlias));

				// Only the room creator/admins (those who can send the canonical
				// alias state event) should trigger the state update. If the
				// remover lacks the power level to send it, leave the stale state
				// untouched rather than failing the deletion.
				if (referencesAlias) {
					const newContent: JsonObject = {};
					if (content.alias && content.alias !== roomAlias) {
						newContent.alias = content.alias;
					}
					if (Array.isArray(content.alt_aliases)) {
						const altAliases = content.alt_aliases.filter(
							(a) => a !== roomAlias,
						);
						if (altAliases.length > 0) newContent.alt_aliases = altAliases;
					}

					const authEvents = selectAuthEvents(
						"m.room.canonical_alias",
						"",
						room,
						userId,
					);
					const { event, eventId } = buildEvent({
						roomId: result.room_id,
						sender: userId,
						type: "m.room.canonical_alias",
						content: newContent,
						stateKey: "",
						depth: room.depth + 1,
						prevEvents: [...room.forward_extremities],
						authEvents,
						serverName,
						roomVersion: room.room_version,
					});

					try {
						checkEventAuth(event, eventId, room);
						await storage.setStateEvent(result.room_id, event, eventId);
						room.depth += 1;
						room.forward_extremities = [eventId];
					} catch {
						// Sender lacks power level to update canonical alias; the alias
						// is still deleted, but the stale state event remains.
					}
				}
			}
		}

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

export const getRoomAliases =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		await requireJoinedRoom(storage, roomId, req.userId as string);

		const aliases = await storage.getAliasesForRoom(roomId);
		return { status: 200, body: { aliases } };
	};
