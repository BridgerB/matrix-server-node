import { forbidden, notFound } from "../../errors.ts";
import { computeEventId, redactEvent } from "../../events.ts";
import { isServerAllowedByAcl } from "../../federation/acl.ts";
import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";
import type { PDU } from "../../types/events.ts";
import type {
	EventId,
	RoomId,
	ServerName,
	Timestamp,
} from "../../types/index.ts";

/**
 * Extract the server name portion of a Matrix user ID (`@user:server`).
 */
const serverFromUserId = (userId: string): string => {
	const idx = userId.indexOf(":");
	return idx === -1 ? "" : userId.slice(idx + 1);
};

/**
 * Reconstruct the room state visible at a given event by folding together all
 * state events reachable through its `prev_events` chain (plus the event itself
 * if it is a state event), keeping the highest-depth event for each
 * `(type, state_key)` tuple.
 *
 * `MemoryStorage.getStateAtEvent` only returns the *current* room state, which
 * is wrong for history-visibility checks on historical events, so we walk the
 * DAG ourselves. This is an approximation of full state resolution but is exact
 * for the linear / simple DAGs exercised by the federation backfill tests.
 */
async function stateAtEvent(
	storage: Storage,
	event: PDU,
): Promise<Map<string, PDU>> {
	const latestByKey = new Map<string, PDU>();
	const visited = new Set<EventId>();
	// Seed with the prev_events; if the event itself is a state event it is
	// considered part of the state "at" that event.
	const queue: EventId[] = [...event.prev_events];
	if (event.state_key !== undefined) {
		latestByKey.set(`${event.type}\0${event.state_key}`, event);
	}

	// Bound the walk so a pathological DAG cannot hang the request.
	let budget = 2000;
	while (queue.length > 0 && budget-- > 0) {
		const id = queue.shift() as EventId;
		if (visited.has(id)) continue;
		visited.add(id);
		const entry = await storage.getEvent(id);
		if (!entry) continue;
		const cur = entry.event;
		if (cur.state_key !== undefined) {
			const key = `${cur.type}\0${cur.state_key}`;
			const existing = latestByKey.get(key);
			if (!existing || cur.depth > existing.depth) {
				latestByKey.set(key, cur);
			}
		}
		for (const prev of cur.prev_events) {
			if (!visited.has(prev)) queue.push(prev);
		}
	}
	return latestByKey;
}

/**
 * Decide whether the requesting server is allowed to see an event in full,
 * mirroring Synapse's `event_visible_to_server` (rust/src/events/filter.rs):
 *
 *   - If history visibility at the event is not `invited`/`joined`
 *     (i.e. `shared` or `world_readable`) the event is fully visible.
 *   - Otherwise the server must have a member that is `join`ed (for `joined`)
 *     or `join`ed/`invite`d (for `invited`) in the state at that event.
 */
async function eventVisibleToServer(
	storage: Storage,
	event: PDU,
	server: string,
): Promise<boolean> {
	const state = await stateAtEvent(storage, event);
	const visEvent = state.get("m.room.history_visibility\0");
	const visibility =
		(visEvent?.content["history_visibility"] as string | undefined) ?? "shared";

	if (visibility !== "invited" && visibility !== "joined") {
		return true;
	}

	for (const [key, stateEvent] of state) {
		if (!key.startsWith("m.room.member\0")) continue;
		const stateKey = key.slice("m.room.member\0".length);
		if (serverFromUserId(stateKey) !== server) continue;
		const membership = stateEvent.content["membership"] as string | undefined;
		if (membership === "join") return true;
		if (membership === "invite" && visibility === "invited") return true;
	}
	return false;
}

export const getFederationEvent =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const eventId = req.params.eventId as EventId;
		const result = await storage.getEvent(eventId);
		if (!result) throw notFound("Event not found");

		return {
			status: 200,
			body: {
				origin: serverName,
				origin_server_ts: Date.now(),
				pdus: [result.event],
			},
		};
	};

export const getFederationRoomState =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const eventId = req.query.get("event_id") as EventId | null;

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		if (!isServerAllowedByAcl(req.origin as ServerName, room))
			throw forbidden("Server is denied by ACL");

		const stateMap = eventId
			? await storage.getStateAtEvent(roomId, eventId)
			: room.state_events;

		if (!stateMap) throw notFound("State not found");

		const pdus = [...stateMap.values()];
		const authEventIds = new Set<EventId>();
		for (const event of pdus) {
			for (const id of event.auth_events) authEventIds.add(id);
		}
		const authChain = await storage.getAuthChain([...authEventIds]);

		return {
			status: 200,
			body: { pdus, auth_chain: authChain },
		};
	};

export const getFederationRoomStateIds =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const eventId = req.query.get("event_id") as EventId | null;

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		if (!isServerAllowedByAcl(req.origin as ServerName, room))
			throw forbidden("Server is denied by ACL");

		const stateMap = eventId
			? await storage.getStateAtEvent(roomId, eventId)
			: room.state_events;

		if (!stateMap) throw notFound("State not found");

		const pduIds = [...stateMap.values()].map((e) => computeEventId(e));
		const authEventIds = new Set<EventId>();
		for (const event of stateMap.values()) {
			for (const id of event.auth_events) authEventIds.add(id);
		}
		const authChain = await storage.getAuthChain([...authEventIds]);
		const authChainIds = authChain.map((e) => computeEventId(e));

		return {
			status: 200,
			body: { pdu_ids: pduIds, auth_chain_ids: authChainIds },
		};
	};

export const getFederationEventAuth =
	(storage: Storage): Handler =>
	async (req) => {
		const eventId = req.params.eventId as EventId;
		const result = await storage.getEvent(eventId);
		if (!result) throw notFound("Event not found");

		const authChain = await storage.getAuthChain(result.event.auth_events);

		return {
			status: 200,
			body: { auth_chain: authChain },
		};
	};

export const postFederationBackfill =
	(storage: Storage, serverName: string): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		// Synapse caps backfill at 100 events per request.
		const rawLimit = parseInt(req.query.get("limit") ?? "100", 10);
		const limit = Math.min(Number.isNaN(rawLimit) ? 100 : rawLimit, 100);
		// `v` is a repeated query parameter naming the events to backfill from.
		const seeds = req.query.getAll("v") as EventId[];

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		const origin = req.origin as ServerName;
		if (!isServerAllowedByAcl(origin, room))
			throw forbidden("Server is denied by ACL");

		// Walk the room DAG backward (by prev_events) starting from the seed
		// events, newest-first, collecting up to `limit` events. Mirrors
		// Synapse's `_get_backfill_events` priority-queue traversal ordered by
		// (-depth, -origin_server_ts).
		const collected = new Map<EventId, PDU>();
		const visited = new Set<EventId>();
		// Priority frontier as a simple array we keep sorted newest-first.
		const frontier: { id: EventId; depth: number; ts: number }[] = [];

		const pushFrontier = (entry: {
			id: EventId;
			depth: number;
			ts: number;
		}) => {
			if (visited.has(entry.id)) return;
			frontier.push(entry);
		};

		for (const id of seeds) {
			const entry = await storage.getEvent(id);
			if (!entry || entry.event.room_id !== roomId) continue;
			pushFrontier({
				id,
				depth: entry.event.depth,
				ts: entry.event.origin_server_ts,
			});
		}

		let budget = 5000;
		while (frontier.length > 0 && collected.size < limit && budget-- > 0) {
			// Pick the newest (highest depth, then ts) event.
			frontier.sort((a, b) => b.depth - a.depth || b.ts - a.ts);
			const item = frontier.shift()!;
			if (visited.has(item.id)) continue;
			visited.add(item.id);

			const entry = await storage.getEvent(item.id);
			if (!entry || entry.event.room_id !== roomId) continue;
			collected.set(item.id, entry.event);
			if (collected.size >= limit) break;

			for (const prevId of entry.event.prev_events) {
				if (visited.has(prevId) || collected.has(prevId)) continue;
				const prevEntry = await storage.getEvent(prevId);
				if (!prevEntry || prevEntry.event.room_id !== roomId) continue;
				pushFrontier({
					id: prevId,
					depth: prevEntry.event.depth,
					ts: prevEntry.event.origin_server_ts,
				});
			}
		}

		// Apply history-visibility filtering (redacting events the requesting
		// server may not see), then order newest-first.
		const pdus: PDU[] = [];
		for (const event of collected.values()) {
			const visible = await eventVisibleToServer(storage, event, origin);
			pdus.push(visible ? event : redactEvent(event));
		}
		pdus.sort(
			(a, b) => b.depth - a.depth || b.origin_server_ts - a.origin_server_ts,
		);

		return {
			status: 200,
			body: {
				origin: serverName,
				origin_server_ts: Date.now(),
				pdus,
			},
		};
	};

export const postFederationMissingEvents =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const body = (req.body ?? {}) as {
			limit?: number;
			min_depth?: number;
			earliest_events?: EventId[];
			latest_events?: EventId[];
		};

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		if (!isServerAllowedByAcl(req.origin as ServerName, room))
			throw forbidden("Server is denied by ACL");

		const origin = req.origin as ServerName;

		// Synapse caps get_missing_events at 20 events per request.
		const limit = Math.min(body.limit ?? 10, 20);
		// `earliest_events` mark the boundary: we stop walking when we reach
		// them and never return them. `latest_events` are the starting points
		// but are themselves excluded from the response (the requester already
		// has them). Mirrors Synapse's `_get_missing_events`.
		const seen = new Set<EventId>(body.earliest_events ?? []);
		let front = (body.latest_events ?? []).filter((id) => !seen.has(id));

		// Build the result working backwards from latest_events.
		const resultIds: EventId[] = [];
		const eventsById = new Map<EventId, PDU>();

		let budget = 5000;
		while (front.length > 0 && resultIds.length < limit && budget-- > 0) {
			const next: EventId[] = [];
			for (const id of front) {
				if (resultIds.length >= limit) break;
				const entry = await storage.getEvent(id);
				if (!entry || entry.event.room_id !== roomId) continue;
				for (const prevId of entry.event.prev_events) {
					if (seen.has(prevId)) continue;
					seen.add(prevId);
					if (resultIds.length >= limit) break;
					const prevEntry = await storage.getEvent(prevId);
					if (!prevEntry || prevEntry.event.room_id !== roomId) continue;
					eventsById.set(prevId, prevEntry.event);
					resultIds.push(prevId);
					next.push(prevId);
				}
			}
			front = next;
		}

		// We built the list backwards from latest_events; reverse so the events
		// are approximately chronological (oldest first).
		resultIds.reverse();

		const events: PDU[] = [];
		for (const id of resultIds) {
			const event = eventsById.get(id)!;
			const visible = await eventVisibleToServer(storage, event, origin);
			events.push(visible ? event : redactEvent(event));
		}

		return {
			status: 200,
			body: { events },
		};
	};

export const getFederationTimestampToEvent =
	(storage: Storage): Handler =>
	async (req) => {
		const roomId = req.params.roomId as RoomId;
		const tsStr = req.query.get("ts");
		const dir = req.query.get("dir") ?? "f";

		if (!tsStr) throw notFound("Missing ts parameter");
		const ts = parseInt(tsStr, 10) as Timestamp;

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		if (!isServerAllowedByAcl(req.origin as ServerName, room))
			throw forbidden("Server is denied by ACL");

		// Events are stored in forward chronological order
		const result = await storage.getEventsByRoom(roomId, 10000, undefined, "f");
		const events = result.events;

		let closest: { event: PDU; eventId: EventId } | undefined;

		if (dir === "f") {
			for (const entry of events) {
				if (entry.event.origin_server_ts >= ts) {
					closest = entry;
					break;
				}
			}
		} else {
			for (const entry of events) {
				if (entry.event.origin_server_ts <= ts) {
					closest = entry;
				} else {
					break;
				}
			}
		}

		if (!closest) throw notFound("No event found");

		return {
			status: 200,
			body: {
				event_id: closest.eventId,
				origin_server_ts: closest.event.origin_server_ts,
			},
		};
	};
