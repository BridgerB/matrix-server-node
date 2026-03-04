import type { Handler } from "../router.ts";
import type { Storage } from "../storage/interface.ts";
import type { JsonObject } from "../types/json.ts";
import {
	buildEvent,
	selectAuthEvents,
	checkEventAuth,
	pduToClientEvent,
	getMembership,
	getUserPowerLevel,
	getPowerLevels,
	redactEvent,
} from "../events.ts";
import {
	forbidden,
	notFound,
	roomNotFound,
	notJoined,
	badJson,
} from "../errors.ts";
import { indexRelation, bundleAggregations } from "../relations.ts";

// =============================================================================
// HELPERS
// =============================================================================

function requireJoined(roomMembership: string | undefined): void {
	if (roomMembership !== "join") throw notJoined();
}

// =============================================================================
// PUT /rooms/:roomId/send/:eventType/:txnId
// =============================================================================

export function putSendEvent(storage: Storage, serverName: string): Handler {
	return async (req) => {
		const roomId = req.params["roomId"]!;
		const eventType = req.params["eventType"]!;
		const txnId = req.params["txnId"]!;
		const userId = req.userId!;
		const deviceId = req.deviceId!;

		// Idempotency check
		const existing = await storage.getTxnEventId(userId, deviceId, txnId);
		if (existing) return { status: 200, body: { event_id: existing } };

		const room = await storage.getRoom(roomId);
		if (!room) throw roomNotFound();
		requireJoined(getMembership(room, userId));

		const authEvents = selectAuthEvents(eventType, undefined, room, userId);
		const { event, eventId } = buildEvent({
			roomId,
			sender: userId,
			type: eventType,
			content: (req.body ?? {}) as JsonObject,
			depth: room.depth,
			prevEvents: [...room.forward_extremities],
			authEvents,
			serverName,
		});

		checkEventAuth(event, eventId, room);
		await storage.storeEvent(event, eventId);
		await indexRelation(storage, event, eventId);

		room.depth++;
		room.forward_extremities = [eventId];

		await storage.setTxnEventId(userId, deviceId, txnId, eventId);
		return { status: 200, body: { event_id: eventId } };
	};
}

// =============================================================================
// PUT /rooms/:roomId/state/:eventType(/:stateKey)
// =============================================================================

export function putStateEvent(storage: Storage, serverName: string): Handler {
	return async (req) => {
		const roomId = req.params["roomId"]!;
		const eventType = req.params["eventType"]!;
		const stateKey = req.params["stateKey"] ?? "";
		const userId = req.userId!;

		const room = await storage.getRoom(roomId);
		if (!room) throw roomNotFound();
		requireJoined(getMembership(room, userId));

		const authEvents = selectAuthEvents(eventType, stateKey, room, userId);
		const { event, eventId } = buildEvent({
			roomId,
			sender: userId,
			type: eventType,
			content: (req.body ?? {}) as JsonObject,
			stateKey,
			depth: room.depth,
			prevEvents: [...room.forward_extremities],
			authEvents,
			serverName,
		});

		checkEventAuth(event, eventId, room);
		await storage.setStateEvent(roomId, event, eventId);

		room.depth++;
		room.forward_extremities = [eventId];

		return { status: 200, body: { event_id: eventId } };
	};
}

// =============================================================================
// GET /rooms/:roomId/state
// =============================================================================

export function getAllState(storage: Storage): Handler {
	return async (req) => {
		const roomId = req.params["roomId"]!;
		const room = await storage.getRoom(roomId);
		if (!room) throw roomNotFound();
		requireJoined(getMembership(room, req.userId!));

		const stateEntries = await storage.getAllState(roomId);
		const events = stateEntries.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);
		return { status: 200, body: events };
	};
}

// =============================================================================
// GET /rooms/:roomId/state/:eventType(/:stateKey)
// =============================================================================

export function getStateEvent(storage: Storage): Handler {
	return async (req) => {
		const roomId = req.params["roomId"]!;
		const eventType = req.params["eventType"]!;
		const stateKey = req.params["stateKey"] ?? "";

		const room = await storage.getRoom(roomId);
		if (!room) throw roomNotFound();
		requireJoined(getMembership(room, req.userId!));

		const entry = await storage.getStateEvent(roomId, eventType, stateKey);
		if (!entry) throw notFound("State event not found");

		return { status: 200, body: entry.event.content };
	};
}

// =============================================================================
// GET /rooms/:roomId/messages
// =============================================================================

export function getMessages(storage: Storage): Handler {
	return async (req) => {
		const roomId = req.params["roomId"]!;
		const room = await storage.getRoom(roomId);
		if (!room) throw roomNotFound();
		requireJoined(getMembership(room, req.userId!));

		const dir = (req.query.get("dir") ?? "f") as "b" | "f";
		if (dir !== "b" && dir !== "f") throw badJson("dir must be 'b' or 'f'");

		const fromStr = req.query.get("from");
		const from = fromStr ? parseInt(fromStr, 10) : undefined;
		const limitStr = req.query.get("limit");
		const limit = Math.min(Math.max(parseInt(limitStr ?? "10", 10), 1), 100);

		const result = await storage.getEventsByRoom(roomId, limit, from, dir);
		const chunk = result.events.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);
		await bundleAggregations(storage, chunk, req.userId!);

		return {
			status: 200,
			body: {
				start: fromStr ?? "0",
				end: result.end !== undefined ? String(result.end) : undefined,
				chunk,
			},
		};
	};
}

// =============================================================================
// GET /rooms/:roomId/members
// =============================================================================

export function getMembers(storage: Storage): Handler {
	return async (req) => {
		const roomId = req.params["roomId"]!;
		const room = await storage.getRoom(roomId);
		if (!room) throw roomNotFound();
		requireJoined(getMembership(room, req.userId!));

		const membershipFilter = req.query.get("membership");
		const notMembershipFilter = req.query.get("not_membership");

		let entries = await storage.getMemberEvents(roomId);

		if (membershipFilter) {
			entries = entries.filter((e) => {
				const m = (e.event.content as Record<string, unknown>)["membership"];
				return m === membershipFilter;
			});
		}
		if (notMembershipFilter) {
			entries = entries.filter((e) => {
				const m = (e.event.content as Record<string, unknown>)["membership"];
				return m !== notMembershipFilter;
			});
		}

		const chunk = entries.map((e) => pduToClientEvent(e.event, e.eventId));
		return { status: 200, body: { chunk } };
	};
}

// =============================================================================
// GET /rooms/:roomId/event/:eventId
// =============================================================================

export function getEvent(storage: Storage): Handler {
	return async (req) => {
		const roomId = req.params["roomId"]!;
		const eventId = req.params["eventId"]!;

		const room = await storage.getRoom(roomId);
		if (!room) throw roomNotFound();
		requireJoined(getMembership(room, req.userId!));

		const entry = await storage.getEvent(eventId);
		if (!entry || entry.event.room_id !== roomId)
			throw notFound("Event not found");

		const clientEvent = pduToClientEvent(entry.event, entry.eventId);
		await bundleAggregations(storage, [clientEvent], req.userId!);
		return { status: 200, body: clientEvent };
	};
}

// =============================================================================
// POST /rooms/:roomId/redact/:eventId/:txnId
// =============================================================================

export function postRedact(storage: Storage, serverName: string): Handler {
	return async (req) => {
		const roomId = req.params["roomId"]!;
		const targetEventId = req.params["eventId"]!;
		const txnId = req.params["txnId"]!;
		const userId = req.userId!;
		const deviceId = req.deviceId!;

		// Idempotency check
		const existing = await storage.getTxnEventId(userId, deviceId, txnId);
		if (existing) return { status: 200, body: { event_id: existing } };

		const room = await storage.getRoom(roomId);
		if (!room) throw roomNotFound();
		requireJoined(getMembership(room, userId));

		// Check target event exists
		const targetEntry = await storage.getEvent(targetEventId);
		if (!targetEntry || targetEntry.event.room_id !== roomId) {
			throw notFound("Event not found");
		}

		// Check power: sender needs redact PL, OR is the original sender
		const pl = getPowerLevels(room);
		const senderPl = getUserPowerLevel(userId, room);
		const redactPl = pl.redact ?? 50;
		if (senderPl < redactPl && targetEntry.event.sender !== userId) {
			throw forbidden("Insufficient power level to redact");
		}

		const body = (req.body ?? {}) as { reason?: string };
		const content: JsonObject = {};
		if (body.reason) content["reason"] = body.reason;

		const authEvents = selectAuthEvents(
			"m.room.redaction",
			undefined,
			room,
			userId,
		);
		const { event, eventId } = buildEvent({
			roomId,
			sender: userId,
			type: "m.room.redaction",
			content,
			depth: room.depth,
			prevEvents: [...room.forward_extremities],
			authEvents,
			redacts: targetEventId,
			serverName,
		});

		checkEventAuth(event, eventId, room);
		await storage.storeEvent(event, eventId);

		room.depth++;
		room.forward_extremities = [eventId];

		// Apply redaction to target event
		const redacted = redactEvent(targetEntry.event);
		redacted.unsigned = {
			...redacted.unsigned,
			redacted_because: pduToClientEvent(event, eventId),
		};
		// Update the stored event in-place (memory storage)
		Object.assign(targetEntry.event, redacted);

		await storage.setTxnEventId(userId, deviceId, txnId, eventId);
		return { status: 200, body: { event_id: eventId } };
	};
}

// =============================================================================
// GET /rooms/:roomId/context/:eventId
// =============================================================================

export function getContext(storage: Storage): Handler {
	return async (req) => {
		const roomId = req.params["roomId"]!;
		const eventId = req.params["eventId"]!;
		const userId = req.userId!;

		const room = await storage.getRoom(roomId);
		if (!room) throw roomNotFound();
		requireJoined(getMembership(room, userId));

		const entry = await storage.getEvent(eventId);
		if (!entry || entry.event.room_id !== roomId)
			throw notFound("Event not found");

		const limit = Math.min(
			Math.max(parseInt(req.query.get("limit") ?? "10", 10), 1),
			100,
		);
		const halfLimit = Math.max(Math.floor(limit / 2), 1);

		// Get full timeline to find surrounding events
		const timeline = await storage.getEventsByRoom(
			roomId,
			10000,
			undefined,
			"f",
		);
		const targetIdx = timeline.events.findIndex((e) => e.eventId === eventId);

		let eventsBefore: typeof timeline.events = [];
		let eventsAfter: typeof timeline.events = [];

		if (targetIdx >= 0) {
			eventsBefore = timeline.events
				.slice(Math.max(0, targetIdx - halfLimit), targetIdx)
				.reverse();
			eventsAfter = timeline.events.slice(
				targetIdx + 1,
				targetIdx + 1 + halfLimit,
			);
		}

		const stateEntries = await storage.getAllState(roomId);
		const state = stateEntries.map((e) => pduToClientEvent(e.event, e.eventId));

		const contextEvent = pduToClientEvent(entry.event, entry.eventId);
		const beforeEvents = eventsBefore.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);
		const afterEvents = eventsAfter.map((e) =>
			pduToClientEvent(e.event, e.eventId),
		);
		await bundleAggregations(
			storage,
			[contextEvent, ...beforeEvents, ...afterEvents],
			userId,
		);

		return {
			status: 200,
			body: {
				event: contextEvent,
				events_before: beforeEvents,
				events_after: afterEvents,
				state,
				start:
					eventsBefore.length > 0
						? String(targetIdx - eventsBefore.length)
						: undefined,
				end:
					eventsAfter.length > 0
						? String(targetIdx + eventsAfter.length + 1)
						: undefined,
			},
		};
	};
}
