import { pduToClientEvent } from "../events.ts";
import { bundleAggregations } from "../relations.ts";
import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { ClientEvent } from "../types/events.ts";
import type { DeviceId, RoomId, UserId } from "../types/index.ts";

const MAX_TIMEOUT = 30000;
const DEFAULT_TIMELINE_LIMIT = 20;

interface SlidingSyncListFilter {
	is_dm?: boolean;
	room_types?: string[];
	not_room_types?: string[];
}

interface SlidingSyncList {
	ranges: [number, number][];
	sort?: string[];
	filters?: SlidingSyncListFilter;
	required_state?: [string, string][];
	timeline_limit?: number;
}

interface RoomSubscription {
	required_state?: [string, string][];
	timeline_limit?: number;
}

interface SlidingSyncRequest {
	pos?: string;
	timeout?: number;
	lists?: Record<string, SlidingSyncList>;
	room_subscriptions?: Record<string, RoomSubscription>;
	extensions?: {
		e2ee?: { enabled?: boolean };
		to_device?: { enabled?: boolean; since?: string };
		account_data?: { enabled?: boolean };
	};
}

interface SlidingSyncRoomResponse {
	name?: string;
	avatar?: string;
	initial?: boolean;
	required_state?: ClientEvent[];
	timeline?: ClientEvent[];
	prev_batch?: string;
	joined_count?: number;
	invited_count?: number;
	notification_count?: number;
	highlight_count?: number;
}

interface SlidingSyncOp {
	op: "SYNC";
	range: [number, number];
	room_ids: string[];
}

interface SlidingSyncListResponse {
	count: number;
	ops: SlidingSyncOp[];
}

interface SlidingSyncResponse {
	pos: string;
	lists?: Record<string, SlidingSyncListResponse>;
	rooms?: Record<string, SlidingSyncRoomResponse>;
	extensions?: {
		e2ee?: {
			device_one_time_keys_count?: Record<string, number>;
			device_unused_fallback_key_types?: string[];
		};
		to_device?: {
			next_batch?: string;
			events?: unknown[];
		};
		account_data?: {
			global?: ClientEvent[];
		};
	};
}

/**
 * Compute a human-readable room name from state events.
 * Check m.room.name first, then fall back to computing from member list.
 */
const computeRoomName = async (
	storage: Storage,
	roomId: RoomId,
	userId: UserId,
): Promise<string | undefined> => {
	const nameEvent = await storage.getStateEvent(roomId, "m.room.name", "");
	if (nameEvent) {
		const name = (nameEvent.event.content as Record<string, unknown>)
			.name as string | undefined;
		if (name) return name;
	}

	const canonicalAliasEvent = await storage.getStateEvent(
		roomId,
		"m.room.canonical_alias",
		"",
	);
	if (canonicalAliasEvent) {
		const alias = (
			canonicalAliasEvent.event.content as Record<string, unknown>
		).alias as string | undefined;
		if (alias) return alias;
	}

	// Fall back to member names
	const members = await storage.getMemberEvents(roomId);
	const joinedOrInvited = members.filter((m) => {
		const membership = (m.event.content as Record<string, unknown>)
			.membership as string;
		return membership === "join" || membership === "invite";
	});
	const otherMembers = joinedOrInvited.filter(
		(m) => m.event.state_key !== userId,
	);

	if (otherMembers.length === 0) {
		// Empty room or only self
		return "Empty Room";
	}
	if (otherMembers.length === 1) {
		const member = otherMembers[0]!;
		const displayname = (member.event.content as Record<string, unknown>)
			.displayname as string | undefined;
		return displayname ?? (member.event.state_key as string);
	}
	// Multiple other members
	const first = otherMembers[0]!;
	const firstName =
		((first.event.content as Record<string, unknown>).displayname as
			| string
			| undefined) ?? (first.event.state_key as string);
	return `${firstName} and ${otherMembers.length - 1} others`;
};

/**
 * Get the latest event timestamp in a room for sorting by recency.
 */
const getRoomLatestTimestamp = async (
	storage: Storage,
	roomId: RoomId,
): Promise<number> => {
	const result = await storage.getEventsByRoom(roomId, 1, undefined, "b");
	const latest = result.events[0];
	if (latest) {
		return latest.event.origin_server_ts;
	}
	return 0;
};

/**
 * Check if a room is a DM by looking at user's m.direct account data.
 */
const isDmRoom = async (
	storage: Storage,
	userId: UserId,
	roomId: RoomId,
): Promise<boolean> => {
	const directData = await storage.getGlobalAccountData(userId, "m.direct");
	if (!directData) return false;

	// m.direct is { userId: [roomId, ...], ... }
	for (const roomIds of Object.values(directData)) {
		if (Array.isArray(roomIds) && roomIds.includes(roomId)) {
			return true;
		}
	}
	return false;
};

/**
 * Get the room type from m.room.create event.
 */
const getRoomType = async (
	storage: Storage,
	roomId: RoomId,
): Promise<string | undefined> => {
	const createEvent = await storage.getStateEvent(roomId, "m.room.create", "");
	if (!createEvent) return undefined;
	return (createEvent.event.content as Record<string, unknown>).type as
		| string
		| undefined;
};

/**
 * Filter rooms based on list filters.
 */
const filterRooms = async (
	storage: Storage,
	userId: UserId,
	roomIds: RoomId[],
	filters: SlidingSyncListFilter | undefined,
): Promise<RoomId[]> => {
	if (!filters) return roomIds;

	const result: RoomId[] = [];
	for (const roomId of roomIds) {
		// is_dm filter
		if (filters.is_dm !== undefined) {
			const dm = await isDmRoom(storage, userId, roomId);
			if (filters.is_dm !== dm) continue;
		}

		// room_types filter
		if (filters.room_types !== undefined) {
			const roomType = await getRoomType(storage, roomId);
			// room_types includes null to mean "no type set"
			const matchesType = filters.room_types.some(
				(t) => (t === null && roomType === undefined) || t === roomType,
			);
			if (!matchesType) continue;
		}

		// not_room_types filter
		if (filters.not_room_types !== undefined) {
			const roomType = await getRoomType(storage, roomId);
			const excluded = filters.not_room_types.some(
				(t) => (t === null && roomType === undefined) || t === roomType,
			);
			if (excluded) continue;
		}

		result.push(roomId);
	}
	return result;
};

/**
 * Build the required_state for a room based on requested state event type/key pairs.
 */
const buildRequiredState = async (
	storage: Storage,
	roomId: RoomId,
	requiredState: [string, string][] | undefined,
): Promise<ClientEvent[]> => {
	if (!requiredState || requiredState.length === 0) return [];

	const events: ClientEvent[] = [];
	const seenKeys = new Set<string>();

	for (const [eventType, stateKey] of requiredState) {
		// Wildcard type and key: return all state
		if (eventType === "*" && stateKey === "*") {
			const allState = await storage.getAllState(roomId);
			for (const s of allState) {
				const key = `${s.event.type}\0${s.event.state_key ?? ""}`;
				if (!seenKeys.has(key)) {
					seenKeys.add(key);
					events.push(pduToClientEvent(s.event, s.eventId));
				}
			}
			continue;
		}

		// Wildcard state key: return all state events of that type
		if (stateKey === "*") {
			const allState = await storage.getAllState(roomId);
			for (const s of allState) {
				if (s.event.type === eventType) {
					const key = `${s.event.type}\0${s.event.state_key ?? ""}`;
					if (!seenKeys.has(key)) {
						seenKeys.add(key);
						events.push(pduToClientEvent(s.event, s.eventId));
					}
				}
			}
			continue;
		}

		// Specific type and key
		const key = `${eventType}\0${stateKey}`;
		if (seenKeys.has(key)) continue;
		const stateEvent = await storage.getStateEvent(roomId, eventType, stateKey);
		if (stateEvent) {
			seenKeys.add(key);
			events.push(pduToClientEvent(stateEvent.event, stateEvent.eventId));
		}
	}

	return events;
};

/**
 * Build room data for a sliding sync response.
 */
const buildRoomData = async (
	storage: Storage,
	roomId: RoomId,
	userId: UserId,
	requiredState: [string, string][] | undefined,
	timelineLimit: number,
	isInitial: boolean,
): Promise<SlidingSyncRoomResponse> => {
	const roomData: SlidingSyncRoomResponse = {};

	// Room name
	roomData.name = await computeRoomName(storage, roomId, userId);

	// Avatar
	const avatarEvent = await storage.getStateEvent(
		roomId,
		"m.room.avatar",
		"",
	);
	if (avatarEvent) {
		roomData.avatar = (avatarEvent.event.content as Record<string, unknown>)
			.url as string | undefined;
	}

	// Initial flag
	if (isInitial) {
		roomData.initial = true;
	}

	// Required state
	roomData.required_state = await buildRequiredState(
		storage,
		roomId,
		requiredState,
	);

	// Timeline
	const limit = Math.min(timelineLimit, 50);
	const result = await storage.getEventsByRoom(roomId, limit, undefined, "b");
	const timelineEvents = result.events.reverse();
	const timelineClientEvents = timelineEvents.map((e) =>
		pduToClientEvent(e.event, e.eventId),
	);
	await bundleAggregations(storage, timelineClientEvents, userId);
	roomData.timeline = timelineClientEvents;

	// prev_batch for pagination
	const totalResult = await storage.getEventsByRoom(
		roomId,
		limit + 1,
		undefined,
		"b",
	);
	const limited = totalResult.events.length > limit;
	if (limited && result.end !== undefined) {
		roomData.prev_batch = String(result.end);
	}

	// Member counts
	const members = await storage.getMemberEvents(roomId);
	roomData.joined_count = members.filter(
		(m) =>
			(m.event.content as Record<string, unknown>).membership === "join",
	).length;
	roomData.invited_count = members.filter(
		(m) =>
			(m.event.content as Record<string, unknown>).membership === "invite",
	).length;

	// Notification counts (simple: just set to 0)
	roomData.notification_count = 0;
	roomData.highlight_count = 0;

	return roomData;
};

export const slidingSync =
	(storage: Storage, _serverName: string): Handler =>
	async (req) => {
		const userId = req.userId as UserId;
		const deviceId = req.deviceId as DeviceId;
		const body = (req.body ?? {}) as SlidingSyncRequest;

		const pos = body.pos !== undefined ? parseInt(body.pos, 10) : undefined;
		const timeout = Math.min(
			Math.max(body.timeout ?? 0, 0),
			MAX_TIMEOUT,
		);

		// Long-poll if we have a position and timeout
		if (pos !== undefined && timeout > 0) {
			await storage.waitForEvents(pos, timeout);
		}

		const nextBatch = await storage.getStreamPosition();
		const isInitial = pos === undefined;

		// Get user's joined rooms
		const userRooms = await storage.getRoomsForUserWithMembership(userId);
		const joinedRoomIds = userRooms
			.filter((r) => r.membership === "join")
			.map((r) => r.roomId);

		const response: SlidingSyncResponse = {
			pos: String(nextBatch),
		};

		// Track which rooms need full data in the response
		const roomsToInclude = new Map<
			RoomId,
			{ requiredState?: [string, string][]; timelineLimit: number }
		>();

		// Process lists
		if (body.lists && Object.keys(body.lists).length > 0) {
			response.lists = {};

			for (const [listKey, list] of Object.entries(body.lists)) {
				// Filter rooms
				const filteredRooms = await filterRooms(
					storage,
					userId,
					joinedRoomIds,
					list.filters,
				);

				// Sort rooms (default: by_recency)
				const sortMode =
					list.sort && list.sort.length > 0 ? list.sort[0] : "by_recency";

				let sortedRooms: RoomId[];
				if (sortMode === "by_name") {
					// Sort by room name alphabetically
					const roomNames = new Map<RoomId, string>();
					for (const roomId of filteredRooms) {
						const name = await computeRoomName(storage, roomId, userId);
						roomNames.set(roomId, name ?? "");
					}
					sortedRooms = [...filteredRooms].sort((a, b) => {
						const nameA = roomNames.get(a) ?? "";
						const nameB = roomNames.get(b) ?? "";
						return nameA.localeCompare(nameB);
					});
				} else {
					// by_recency (default)
					const roomTimestamps = new Map<RoomId, number>();
					for (const roomId of filteredRooms) {
						const ts = await getRoomLatestTimestamp(storage, roomId);
						roomTimestamps.set(roomId, ts);
					}
					sortedRooms = [...filteredRooms].sort((a, b) => {
						const tsA = roomTimestamps.get(a) ?? 0;
						const tsB = roomTimestamps.get(b) ?? 0;
						return tsB - tsA; // Most recent first
					});
				}

				const totalCount = sortedRooms.length;
				const ops: SlidingSyncOp[] = [];

				for (const range of list.ranges) {
					const [start, end] = range;
					const clampedEnd = Math.min(end, totalCount - 1);
					if (start > clampedEnd || start >= totalCount) {
						ops.push({
							op: "SYNC",
							range,
							room_ids: [],
						});
						continue;
					}

					const roomIdsInRange = sortedRooms.slice(start, clampedEnd + 1);
					ops.push({
						op: "SYNC",
						range,
						room_ids: roomIdsInRange,
					});

					// Add rooms in range to the set of rooms to include
					for (const roomId of roomIdsInRange) {
						if (!roomsToInclude.has(roomId)) {
							roomsToInclude.set(roomId, {
								requiredState: list.required_state,
								timelineLimit:
									list.timeline_limit ?? DEFAULT_TIMELINE_LIMIT,
							});
						}
					}
				}

				response.lists[listKey] = {
					count: totalCount,
					ops,
				};
			}
		}

		// Process room subscriptions
		if (body.room_subscriptions) {
			for (const [roomIdStr, sub] of Object.entries(
				body.room_subscriptions,
			)) {
				const roomId = roomIdStr as RoomId;
				// Only include if user is actually in the room
				if (joinedRoomIds.includes(roomId)) {
					roomsToInclude.set(roomId, {
						requiredState: sub.required_state,
						timelineLimit: sub.timeline_limit ?? DEFAULT_TIMELINE_LIMIT,
					});
				}
			}
		}

		// Build room data for all included rooms
		if (roomsToInclude.size > 0) {
			response.rooms = {};
			for (const [roomId, opts] of roomsToInclude) {
				response.rooms[roomId] = await buildRoomData(
					storage,
					roomId,
					userId,
					opts.requiredState,
					opts.timelineLimit,
					isInitial,
				);
			}
		}

		// Process extensions
		if (body.extensions) {
			response.extensions = {};

			// E2EE extension
			if (body.extensions.e2ee?.enabled) {
				const otkCounts = await storage.getOneTimeKeyCounts(
					userId,
					deviceId,
				);
				const fallbackKeyTypes = await storage.getFallbackKeyTypes(
					userId,
					deviceId,
				);
				response.extensions.e2ee = {
					device_one_time_keys_count: otkCounts,
					device_unused_fallback_key_types: fallbackKeyTypes,
				};
			}

			// To-device extension
			if (body.extensions.to_device?.enabled) {
				const toDeviceEvents = await storage.getToDeviceMessages(
					userId,
					deviceId,
				);
				if (toDeviceEvents.length > 0) {
					await storage.clearToDeviceMessages(userId, deviceId);
				}
				response.extensions.to_device = {
					next_batch: String(nextBatch),
					events: toDeviceEvents,
				};
			}

			// Account data extension
			if (body.extensions.account_data?.enabled) {
				const globalData =
					await storage.getAllGlobalAccountData(userId);
				const globalEvents = globalData.map(
					(d) =>
						({
							type: d.type,
							content: d.content,
						}) as unknown as ClientEvent,
				);
				response.extensions.account_data = {
					global: globalEvents,
				};
			}
		}

		return { status: 200, body: response };
	};
