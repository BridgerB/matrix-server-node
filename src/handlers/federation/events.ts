import { forbidden, notFound } from "../../errors.ts";
import { computeEventId } from "../../events.ts";
import { isServerAllowedByAcl } from "../../federation/acl.ts";
import type { Handler } from "../../router.ts";
import type { Storage } from "../../storage/interface.ts";
import type { PDU } from "../../types/events.ts";
import type { EventId, RoomId, ServerName } from "../../types/index.ts";

// =============================================================================
// GET /_matrix/federation/v1/event/:eventId
// =============================================================================

export function getFederationEvent(
	storage: Storage,
	serverName: string,
): Handler {
	return async (req) => {
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
}

// =============================================================================
// GET /_matrix/federation/v1/state/:roomId
// =============================================================================

export function getFederationRoomState(storage: Storage): Handler {
	return async (req) => {
		const roomId = req.params.roomId as RoomId;
		const eventId = req.query.get("event_id") as EventId | null;

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		// Check ACL
		if (!isServerAllowedByAcl(req.origin as ServerName, room)) {
			throw forbidden("Server is denied by ACL");
		}

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
}

// =============================================================================
// GET /_matrix/federation/v1/state_ids/:roomId
// =============================================================================

export function getFederationRoomStateIds(storage: Storage): Handler {
	return async (req) => {
		const roomId = req.params.roomId as RoomId;
		const eventId = req.query.get("event_id") as EventId | null;

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		if (!isServerAllowedByAcl(req.origin as ServerName, room)) {
			throw forbidden("Server is denied by ACL");
		}

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
}

// =============================================================================
// GET /_matrix/federation/v1/event_auth/:roomId/:eventId
// =============================================================================

export function getFederationEventAuth(storage: Storage): Handler {
	return async (req) => {
		const eventId = req.params.eventId as EventId;
		const result = await storage.getEvent(eventId);
		if (!result) throw notFound("Event not found");

		const authChain = await storage.getAuthChain(result.event.auth_events);

		return {
			status: 200,
			body: { auth_chain: authChain },
		};
	};
}

// =============================================================================
// POST /_matrix/federation/v1/backfill/:roomId
// =============================================================================

export function postFederationBackfill(
	storage: Storage,
	serverName: string,
): Handler {
	return async (req) => {
		const roomId = req.params.roomId as RoomId;
		const limit = Math.min(parseInt(req.query.get("limit") ?? "100", 10), 500);
		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		if (!isServerAllowedByAcl(req.origin as ServerName, room)) {
			throw forbidden("Server is denied by ACL");
		}

		// Get events before the given event IDs
		const result = await storage.getEventsByRoom(roomId, limit, undefined, "b");

		return {
			status: 200,
			body: {
				origin: serverName,
				origin_server_ts: Date.now(),
				pdus: result.events.map((e) => e.event),
			},
		};
	};
}

// =============================================================================
// POST /_matrix/federation/v1/get_missing_events/:roomId
// =============================================================================

export function postFederationMissingEvents(storage: Storage): Handler {
	return async (req) => {
		const roomId = req.params.roomId as RoomId;
		const body = (req.body ?? {}) as {
			limit?: number;
			min_depth?: number;
			earliest_events?: EventId[];
			latest_events?: EventId[];
		};

		const room = await storage.getRoom(roomId);
		if (!room) throw notFound("Room not found");

		if (!isServerAllowedByAcl(req.origin as ServerName, room)) {
			throw forbidden("Server is denied by ACL");
		}

		const limit = Math.min(body.limit ?? 10, 50);
		const earliest = new Set(body.earliest_events ?? []);
		const latest = body.latest_events ?? [];

		// BFS backwards from latest_events to earliest_events
		const visited = new Set<EventId>();
		const result: PDU[] = [];
		const queue = [...latest];

		while (queue.length > 0 && result.length < limit) {
			const id = queue.shift() as EventId;
			if (visited.has(id) || earliest.has(id)) continue;
			visited.add(id);

			const entry = await storage.getEvent(id);
			if (!entry) continue;

			result.push(entry.event);

			for (const prevId of entry.event.prev_events) {
				if (!visited.has(prevId) && !earliest.has(prevId)) {
					queue.push(prevId);
				}
			}
		}

		return {
			status: 200,
			body: { events: result },
		};
	};
}
